import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withFileLock } from './file-lock.js';

test('withFileLock serializes competing writers', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task-monitor-lock-'));
  const lockPath = path.join(root, 'state.lock');
  const order = [];
  try {
    await Promise.all([
      withFileLock(lockPath, async () => {
        order.push('first-start');
        await new Promise((resolve) => setTimeout(resolve, 25));
        order.push('first-end');
      }, { timeoutMs: 1000, retryMs: 5 }),
      withFileLock(lockPath, async () => {
        order.push('second');
      }, { timeoutMs: 1000, retryMs: 5 }),
    ]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);
    await assert.rejects(() => fsp.stat(lockPath), { code: 'ENOENT' });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('withFileLock reclaims an old dead owner', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task-monitor-lock-stale-'));
  const lockPath = path.join(root, 'state.lock');
  try {
    await fsp.mkdir(lockPath);
    await fsp.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: 999999,
      createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    }));
    let entered = false;
    await withFileLock(lockPath, async () => { entered = true; }, { timeoutMs: 1000, retryMs: 5, staleMs: 1 });
    assert.equal(entered, true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('withFileLock reclaims an old ownerless lock directory', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'task-monitor-lock-ownerless-'));
  const lockPath = path.join(root, 'state.lock');
  try {
    await fsp.mkdir(lockPath);
    await fsp.writeFile(path.join(lockPath, 'owner.json'), '');
    const old = new Date(Date.now() - 20 * 60_000);
    await fsp.utimes(lockPath, old, old);
    let entered = false;
    await withFileLock(lockPath, async () => { entered = true; }, { timeoutMs: 1000, retryMs: 5, staleMs: 1 });
    assert.equal(entered, true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
