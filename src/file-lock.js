import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_MS = 100;
const DEFAULT_STALE_MS = 10 * 60_000;
const localLockTails = new Map();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readOwner(lockPath) {
  try {
    const owner = JSON.parse(await fsp.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
    return {
      pid: Number(owner?.pid),
      createdAt: Date.parse(owner?.createdAt || ''),
      hasOwner: true,
    };
  } catch {
    const metadata = await fsp.stat(lockPath).catch(() => null);
    return { pid: 0, createdAt: metadata?.mtimeMs || Date.now(), hasOwner: false };
  }
}

/**
 * Serialize updates shared by the API and pipeline processes. mkdir is an
 * atomic operation on the local filesystem, unlike a read-then-rename pair.
 * Dead owners are reclaimed so a killed monitor cannot strand the queue.
 */
export async function withFileLock(lockPath, callback, options = {}) {
  // Calls from the API and runner often contend inside one Node process. A
  // small in-process FIFO avoids a same-tick race where the second caller
  // wins mkdir before the first callback has started; the directory lock still
  // provides cross-process serialization.
  const previous = localLockTails.get(lockPath) || Promise.resolve();
  let releaseLocal;
  const turn = new Promise((resolve) => { releaseLocal = resolve; });
  const currentTail = previous.then(() => turn, () => turn);
  localLockTails.set(lockPath, currentTail);
  await previous.catch(() => {});
  try {
    return await withFileLockDirectory(lockPath, callback, options);
  } finally {
    releaseLocal();
    if (localLockTails.get(lockPath) === currentTail) localLockTails.delete(lockPath);
  }
}

async function withFileLockDirectory(lockPath, callback, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const retryMs = Number.isFinite(Number(options.retryMs)) ? Math.max(10, Number(options.retryMs)) : DEFAULT_RETRY_MS;
  const staleMs = Number.isFinite(Number(options.staleMs)) ? Math.max(retryMs, Number(options.staleMs)) : DEFAULT_STALE_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await fsp.mkdir(lockPath);
      await fsp.writeFile(
        path.join(lockPath, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        'utf8',
      );
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = await readOwner(lockPath);
      const age = Number.isFinite(owner.createdAt) ? Date.now() - owner.createdAt : staleMs + 1;
      if ((!owner.hasOwner || !processIsAlive(owner.pid)) && age >= staleMs) {
        await fsp.rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for file lock: ${lockPath}`);
      }
      await sleep(retryMs);
    }
  }

  try {
    return await callback();
  } finally {
    await fsp.rm(lockPath, { recursive: true, force: true });
  }
}
