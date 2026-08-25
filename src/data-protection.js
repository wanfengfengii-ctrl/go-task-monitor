import fs from 'node:fs';
import path from 'node:path';

function quoteSandboxString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function claudeGenerationSandbox({
  platform = process.platform,
  sandboxExec = '/usr/bin/sandbox-exec',
  bubblewrap = '/usr/bin/bwrap',
  protectedRoot,
  claudeBin,
  claudeArgs = [],
}) {
  if (!path.isAbsolute(protectedRoot)) throw new Error('Claude 保护目录必须是绝对路径');
  if (!path.isAbsolute(claudeBin)) throw new Error('Claude CLI 必须使用绝对路径');
  const resolvedRoot = path.resolve(protectedRoot);
  const canonicalRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync.native(resolvedRoot) : resolvedRoot;
  if (platform === 'linux') {
    if (!path.isAbsolute(bubblewrap)) throw new Error('Bubblewrap 必须使用绝对路径');
    return {
      command: bubblewrap,
      args: [
        '--die-with-parent',
        '--new-session',
        '--bind', '/', '/',
        '--dev-bind', '/dev', '/dev',
        '--proc', '/proc',
        '--ro-bind', canonicalRoot, canonicalRoot,
        '--', claudeBin, ...claudeArgs,
      ],
      profile: `bubblewrap:ro-bind:${canonicalRoot}`,
    };
  }
  if (platform !== 'darwin') throw new Error(`当前平台 ${platform} 缺少已配置的 Claude 文件系统沙箱，拒绝无保护生成项目`);
  const profile = [
    '(version 1)',
    '(allow default)',
    `(deny file-write* (subpath "${quoteSandboxString(canonicalRoot)}"))`,
  ].join('');
  return { command: sandboxExec, args: ['-p', profile, claudeBin, ...claudeArgs], profile };
}

export function datastoreIntegrityDecision(previous, current) {
  const before = {
    taskCount: Math.max(0, Number(previous?.taskCount || 0)),
    jobCount: Math.max(0, Number(previous?.jobCount || 0)),
  };
  const now = {
    taskCount: Math.max(0, Number(current?.taskCount || 0)),
    jobCount: Math.max(0, Number(current?.jobCount || 0)),
  };
  const missing = [];
  if (before.taskCount > 0 && now.taskCount === 0) missing.push(`任务 ${before.taskCount}→0`);
  if (before.jobCount > 0 && now.jobCount === 0) missing.push(`流水线作业 ${before.jobCount}→0`);
  return { trip: missing.length > 0, missing, previous: before, current: now };
}

export function assertProtectedSnapshotPath(snapshotPath, snapshotsRoot) {
  const relative = path.relative(path.resolve(snapshotsRoot), path.resolve(snapshotPath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`快照路径越界：${snapshotPath}`);
  }
  return path.resolve(snapshotPath);
}

export function criticalSnapshotTarOptions(platform = process.platform) {
  if (platform !== 'darwin') return [];
  // bsdtar can receive EDEADLK from APFS while probing sparse regions in files
  // that are atomically replaced during a live snapshot.
  return ['--no-read-sparse', '--no-mac-metadata'];
}
