import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const configurator = path.resolve(import.meta.dirname, '../scripts/configure-claude-model-grader.mjs');

test('Claude-only grader binds Docker target to the public TestModel command', async (context) => {
  const taskDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-only-grader-'));
  context.after(() => fsp.rm(taskDir, { recursive: true, force: true }));
  await fsp.mkdir(path.join(taskDir, 'grader'));
  await fsp.writeFile(path.join(taskDir, 'public.json'), `${JSON.stringify({
    workflow_version: 3,
    task_type: 'bugfix',
    verification_policy_version: 5,
  })}\n`);
  const command = "go test ./internal/store -run '^TestModel_Restart$' -count=1 -v";
  const preflightPath = path.join(taskDir, 'preflight.json');
  await fsp.writeFile(preflightPath, `${JSON.stringify({
    ok: true,
    plan: {
      policy_version: 1,
      verify_cmds: [command],
      verification_test_overlay: 'repository-tests',
      verification_test_files: ['internal/store/restart_model_test.go'],
      verification_test_names: ['TestModel_Restart'],
      verification_test_manifest: [{ path: 'internal/store/restart_model_test.go', sha256: 'a'.repeat(64) }],
    },
  })}\n`);

  await execFileAsync(process.execPath, [configurator, taskDir, preflightPath]);
  const target = await fsp.readFile(path.join(taskDir, 'grader/run_target.sh'), 'utf8');
  const metadata = JSON.parse(await fsp.readFile(path.join(taskDir, 'public.json'), 'utf8'));
  assert.match(target, /GOTOOLCHAIN=local \/bin\/bash -c/);
  assert.doesNotMatch(target, /\/bin\/bash -lc/);
  assert.match(target, /go test \.\/internal\/store/);
  assert.match(target, /TestModel_Restart/);
  assert.deepEqual(metadata.verify_cmds, [command]);
  assert.deepEqual(metadata.verification_test_files, ['internal/store/restart_model_test.go']);
  assert.equal(metadata.verification_test_overlay, 'repository-tests');
});
