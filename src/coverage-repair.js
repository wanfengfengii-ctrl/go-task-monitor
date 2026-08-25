import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function workspaceEntries(root, relative = '') {
  const entries = new Map();
  const directory = path.join(root, relative);
  for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === '.git') continue;
    const filename = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(root, filename);
    if (entry.isDirectory()) {
      for (const [child, descriptor] of await workspaceEntries(root, filename)) entries.set(child, descriptor);
    } else if (entry.isSymbolicLink()) {
      entries.set(filename, `symlink:${await fsp.readlink(absolute)}`);
    } else if (entry.isFile()) {
      entries.set(filename, `file:${sha256(await fsp.readFile(absolute))}`);
    } else {
      entries.set(filename, entry.isFIFO() ? 'fifo' : 'other');
    }
  }
  return entries;
}

export async function coverageRepairNonTestChanges(baselineRoot, workspaceRoot) {
  const [baseline, workspace] = await Promise.all([
    workspaceEntries(path.resolve(baselineRoot)),
    workspaceEntries(path.resolve(workspaceRoot)),
  ]);
  const changes = [];
  for (const filename of [...new Set([...baseline.keys(), ...workspace.keys()])].sort()) {
    if (baseline.get(filename) === workspace.get(filename)) continue;
    if (filename.endsWith('_test.go')) continue;
    changes.push(filename);
  }
  return changes;
}

export async function assertCoverageRepairOnlyChangesTests(baselineRoot, workspaceRoot) {
  const changes = await coverageRepairNonTestChanges(baselineRoot, workspaceRoot);
  if (changes.length) {
    throw new Error(`覆盖补测模式禁止修改生产代码或其他文件：${changes.join(', ')}`);
  }
  return { ok: true, changed_non_test_files: [] };
}
