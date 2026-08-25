import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(child) {
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timeout: ${output}`)), 15_000);
    const observe = (chunk) => {
      output += String(chunk);
      if (!/Go task monitor API listening/.test(output)) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on('data', observe);
    child.stderr.on('data', observe);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${output}`));
    });
  });
}

test('producer API leases one remote repair job and imports its task package', async (t) => {
  const workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'go-task-distributed-server-'));
  const port = await availablePort();
  const token = 'test-worker-token-0123456789abcdef';
  const jobId = 'pipeline-remote-api-001';
  const taskName = 'go-1001-bug-01';
  const libraryRoot = path.join(workRoot, 'go-task-library');
  const jobDir = path.join(libraryRoot, 'pipeline-jobs', jobId);
  const tasksRoot = path.join(libraryRoot, 'tasks');
  const validationRoot = path.join(libraryRoot, 'validation');
  await fsp.mkdir(jobDir, { recursive: true });
  await fsp.mkdir(validationRoot, { recursive: true });
  const activityAt = new Date().toISOString();
  await fsp.writeFile(path.join(validationRoot, 'review_statuses.json'), `${JSON.stringify([
    { taskId: 'go-task-library::go-1001-bug-01', status: 'qualified', updatedAt: activityAt },
    { taskId: 'go-task-library::go-1001-bug-02', status: 'qualified', updatedAt: activityAt },
  ], null, 2)}\n`, 'utf8');
  await fsp.writeFile(path.join(validationRoot, 'platform_submissions.json'), `${JSON.stringify([
    { taskId: 'go-task-library::go-1001-bug-01', bugId: 'go-1001-bug-01', status: 'submitted', submittedAt: activityAt, platformSubmissionId: 'submission-1' },
    { taskId: 'go-task-library::go-1001-bug-02', bugId: 'go-1001-bug-02', status: 'failed', startedAt: activityAt, failedAt: activityAt, error: 'HTTP 503' },
  ], null, 2)}\n`, 'utf8');
  const job = {
    id: jobId,
    status: 'waiting_resource',
    currentStage: 'bug1_task_prepare',
    createdAt: '2026-08-25T01:00:00.000Z',
    updatedAt: '2026-08-25T01:00:00.000Z',
    jobDir,
    tasksRoot,
    request: {
      repository: 'go-1001',
      cloneUrl: 'git@github.com:example/go-1001.git',
      bugCount: 1,
      taskType: 'bugfix',
      projectTier: 'standard',
    },
    mainCommit: 'a'.repeat(40),
    stages: [
      { id: 'main_publish', status: 'passed', scope: 'project' },
      { id: 'bug1_task_prepare', stage: 'task_prepare', status: 'pending', scope: 'bug', bugIndex: 1 },
    ],
    bugs: [{ bugIndex: 1, bugBaseCommit: 'b'.repeat(40), bugBaseDir: path.join(jobDir, 'bug-base-bug1') }],
    waitingResource: { pool: 'remote-repair', stageId: 'bug1_task_prepare', queuedAt: '2026-08-25T01:00:00.000Z' },
    remoteExecution: { protocolVersion: 1, requiredRole: 'repair-worker', status: 'waiting', attempt: 0 },
  };
  await fsp.writeFile(path.join(jobDir, 'job.json'), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      GO_TASK_MONITOR_WORK_ROOT: workRoot,
      GO_TASK_MONITOR_API_PORT: String(port),
      GO_TASK_MONITOR_API_HOST: '127.0.0.1',
      GO_PIPELINE_NODE_ROLE: 'producer',
      GO_PIPELINE_WORKER_TOKEN: token,
      GO_TASK_MONITOR_STARTUP_RECOVERY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await fsp.rm(workRoot, { recursive: true, force: true });
  });
  await waitForServer(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  const identity = { workerId: 'repair-b', role: 'repair-worker', protocolVersion: 1, codeVersion: 'test' };
  const requestJson = async (pathname, method, body, bearer = token) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { response, payload: await response.json() };
  };
  const denied = await requestJson('/api/pipeline/workers/register', 'POST', identity, 'wrong-token');
  assert.equal(denied.response.status, 401);
  const registered = await requestJson('/api/pipeline/workers/register', 'POST', identity);
  assert.equal(registered.response.status, 200);
  const deniedStats = await fetch(`${baseUrl}/api/pipeline/workers/submission-stats`, {
    headers: { authorization: 'Bearer wrong-token' },
  });
  assert.equal(deniedStats.status, 401);
  const statsResponse = await fetch(`${baseUrl}/api/pipeline/workers/submission-stats`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-go-pipeline-worker-id': identity.workerId,
      'x-go-pipeline-worker-protocol': '1',
    },
  });
  assert.equal(statsResponse.status, 200);
  const stats = await statsResponse.json();
  assert.equal(stats.timeZone, 'Asia/Shanghai');
  assert.deepEqual(stats.today, { qualified: 2, uploaded: 1, failed: 1, submitting: 0, pendingUpload: 1 });
  const claimed = await requestJson('/api/pipeline/workers/claim', 'POST', identity);
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.payload.assignment.job.id, jobId);
  const leaseId = claimed.payload.assignment.leaseId;
  const duplicate = await requestJson('/api/pipeline/workers/claim', 'POST', { ...identity, workerId: 'repair-c' });
  assert.equal(duplicate.payload.assignment, null);
  const heartbeat = await requestJson(`/api/pipeline/workers/jobs/${jobId}/heartbeat`, 'POST', { ...identity, leaseId });
  assert.equal(heartbeat.payload.cancelRequested, false);

  const snapshot = structuredClone(claimed.payload.assignment.job);
  snapshot.status = 'running';
  snapshot.currentStage = 'bug1_claude_fix';
  snapshot.jobDir = '/worker/jobs/pipeline-remote-api-001';
  snapshot.tasksRoot = '/worker/tasks';
  snapshot.bugs[0].task = { taskName, taskDir: `/worker/tasks/${taskName}` };
  const accepted = await requestJson(`/api/pipeline/workers/jobs/${jobId}/snapshot`, 'PUT', { ...identity, leaseId, job: snapshot });
  assert.equal(accepted.response.status, 200);

  const packageRoot = path.join(workRoot, 'package-source');
  const packageTask = path.join(packageRoot, taskName);
  await fsp.mkdir(packageTask, { recursive: true });
  await fsp.writeFile(path.join(packageTask, 'public.json'), `${JSON.stringify({
    sample_id: taskName,
    pipeline_job_id: jobId,
    repository: 'go-1001',
  })}\n`, 'utf8');
  await fsp.writeFile(path.join(packageTask, 'PROMPT.md'), 'test\n', 'utf8');
  const archivePath = path.join(workRoot, 'task.tar.gz');
  await execFileAsync('tar', ['-czf', archivePath, '-C', packageRoot, taskName]);
  const archive = await fsp.readFile(archivePath);
  const uploaded = await fetch(`${baseUrl}/api/pipeline/workers/jobs/${jobId}/tasks/${taskName}/package`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'x-go-pipeline-worker-id': identity.workerId,
      'x-go-pipeline-worker-protocol': '1',
      'x-go-pipeline-lease-id': leaseId,
      'content-type': 'application/gzip',
      'content-length': String(archive.length),
    },
    body: archive,
  });
  assert.equal(uploaded.status, 200, await uploaded.text());
  assert.equal(await fsp.readFile(path.join(tasksRoot, taskName, 'PROMPT.md'), 'utf8'), 'test\n');
  const downloaded = await fetch(`${baseUrl}/api/pipeline/workers/jobs/${jobId}/tasks/${taskName}/package`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-go-pipeline-worker-id': identity.workerId,
      'x-go-pipeline-worker-protocol': '1',
      'x-go-pipeline-lease-id': leaseId,
    },
  });
  assert.equal(downloaded.status, 200);
  assert.ok((await downloaded.arrayBuffer()).byteLength > 0);

  snapshot.status = 'passed';
  snapshot.stages[1].status = 'passed';
  const completed = await requestJson(`/api/pipeline/workers/jobs/${jobId}/complete`, 'POST', {
    ...identity, leaseId, outcome: 'passed', job: snapshot,
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.payload.status, 'passed');
  const workerState = await fetch(`${baseUrl}/api/pipeline/workers`).then((response) => response.json());
  assert.equal(workerState.workers.find((worker) => worker.workerId === identity.workerId).status, 'idle');
});
