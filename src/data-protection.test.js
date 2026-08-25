import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertProtectedSnapshotPath, claudeGenerationSandbox, criticalSnapshotTarOptions, datastoreIntegrityDecision } from './data-protection.js';

test('Claude generation refuses unsupported platforms and wraps macOS CLI in a protected sandbox', () => {
  assert.throws(() => claudeGenerationSandbox({ platform: 'linux', protectedRoot: '/data/tasks', claudeBin: '/bin/claude' }), /拒绝无保护/);
  const wrapped = claudeGenerationSandbox({
    platform: 'darwin',
    protectedRoot: '/Users/example/Project With Spaces',
    claudeBin: '/opt/claude',
    claudeArgs: ['--print'],
  });
  assert.equal(wrapped.command, '/usr/bin/sandbox-exec');
  assert.deepEqual(wrapped.args.slice(-2), ['/opt/claude', '--print']);
  assert.match(wrapped.profile, /deny file-write\*/);
  assert.match(wrapped.profile, /Project With Spaces/);
});

test('macOS sandbox blocks a child process from deleting the protected datastore', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec') }, async () => {
  const root = await fsp.mkdtemp(path.join(process.cwd(), '.go-monitor-sandbox-test-'));
  const protectedRoot = path.join(root, 'protected');
  const sentinel = path.join(protectedRoot, 'tasks', 'keep.json');
  await fsp.mkdir(path.dirname(sentinel), { recursive: true });
  await fsp.writeFile(sentinel, '{}\n');
  try {
    const wrapped = claudeGenerationSandbox({
      protectedRoot,
      claudeBin: '/bin/rm',
      claudeArgs: ['-rf', protectedRoot],
    });
    spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' });
    assert.equal(await fsp.readFile(sentinel, 'utf8'), '{}\n');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('datastore circuit breaker trips only on a nonzero-to-zero collapse', () => {
  assert.equal(datastoreIntegrityDecision({ taskCount: 15, jobCount: 4 }, { taskCount: 0, jobCount: 4 }).trip, true);
  assert.equal(datastoreIntegrityDecision({ taskCount: 15, jobCount: 4 }, { taskCount: 15, jobCount: 0 }).trip, true);
  assert.equal(datastoreIntegrityDecision({ taskCount: 0, jobCount: 0 }, { taskCount: 0, jobCount: 0 }).trip, false);
  assert.equal(datastoreIntegrityDecision({ taskCount: 15, jobCount: 4 }, { taskCount: 14, jobCount: 3 }).trip, false);
});

test('snapshot paths must stay below the snapshot root', () => {
  assert.equal(assertProtectedSnapshotPath('/tmp/snapshots/one.tar.gz', '/tmp/snapshots'), '/tmp/snapshots/one.tar.gz');
  assert.throws(() => assertProtectedSnapshotPath('/tmp/tasks', '/tmp/snapshots'), /越界/);
});

test('macOS live snapshots disable APFS sparse probing and metadata sidecars', () => {
  assert.deepEqual(criticalSnapshotTarOptions('darwin'), ['--no-read-sparse', '--no-mac-metadata']);
  assert.deepEqual(criticalSnapshotTarOptions('linux'), []);
});
