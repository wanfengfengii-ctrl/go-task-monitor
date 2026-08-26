import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function identifierSuffix(value) {
  const suffix = String(value || '')
    .replace(/^Test/, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return suffix || 'Regression';
}

export function goldTestNamespace(bugIndex, bugId) {
  const index = Math.max(1, Number(bugIndex) || 1);
  const digest = crypto.createHash('sha256').update(`${index}:${String(bugId || '')}`).digest('hex').slice(0, 8);
  return {
    prefix: `TestGoldB${index}_${digest}_`,
    filename: `grader_b${index}_${digest}_test.go`,
  };
}

export function namespacedGoldTestName(bugIndex, bugId, originalName = '') {
  const namespace = goldTestNamespace(bugIndex, bugId);
  if (String(originalName).startsWith(namespace.prefix)) return String(originalName);
  return `${namespace.prefix}${identifierSuffix(originalName)}`;
}

export function classifyTrajectoryAttemptFailure(message = '') {
  const value = String(message);
  if (/GRADER_COLLISION|grader[_ -]collision|隐藏测试.*(?:冲突|重名)/i.test(value)) return 'grader_collision';
  if (/mutation-audit[\s\S]*(?:未记录\s*(?:PreToolUse|PostToolUse)|baseline.*missing)|Hook 审计.*(?:缺失|失败)/i.test(value)) return 'audit_infrastructure';
  // A scheduler stop can race the child-command failure handler and persist a
  // failed record immediately before the explicit stopped record. Neither is
  // a completed model attempt, so the duplicate must not consume its budget.
  if (/exit=none[，,]\s*signal=SIG(?:TERM|INT|HUP|KILL)|人工停止（SIG(?:TERM|INT|HUP|KILL)）/i.test(value)) return 'runner_infrastructure';
  // A non-zero CLI exit with no terminal result and no stderr is a transport
  // or process failure. Older runners persisted only their progress heartbeats,
  // so retain that exact legacy shape without hiding genuine model/test errors.
  if (/CLAUDE_CLI_EMPTY_FAILURE=1/i.test(value)
    || /^Claude 修复失败（exit=1）：\s*(?:CLAUDE_PROGRESS\s*)+$/iu.test(value.trim())) return 'model_gateway_infrastructure';
  // Claude Code reports model-gateway outages as API Error/api_retry events.
  // Keep the gateway context mandatory so a repository test that merely
  // expects an HTTP 504 response remains a genuine model attempt.
  if (/API\s+Error:\s*504\b|api_retry[\s\S]{0,500}(?:\b504\b|server_error|gateway timeout)|consecutive Claude API retries|(?:model|模型|claude|anthropic)[ _-]?(?:api[ _-]?)?gateway[\s\S]{0,300}(?:\b504\b|server_error|timed?\s*out|超时)|(?:claude|anthropic)\s+api[\s\S]{0,300}(?:\b504\b|server_error|gateway timeout)/i.test(value)) return 'model_gateway_infrastructure';
  // Older diagnosis runners correctly accepted a red target, then accidentally
  // included the injected Gold test in the baseline `go test ./...` run. That
  // is grader pollution, not a failed model diagnosis.
  if (/diagnosis target reproduced as expected[\s\S]*FAILURE_CLASS=public_full/i.test(value)
    && /grader_b\d+_[a-f0-9]+_test\.go|TestGoldB\d+_[A-Za-z0-9_]+/i.test(value)) return 'diagnosis_grader_infrastructure';
  if (/Docker system-side acceptance failed[\s\S]*(?:resolve image config for docker-image:\/\/|failed to resolve source metadata)[\s\S]*(?:context canceled|timed?\s*out|已超时|signal)/i.test(value)) return 'docker_infrastructure';
  if (/error waiting for container:\s*unexpected EOF|Cannot connect to the Docker daemon|Docker daemon|Docker Desktop|context deadline exceeded|TLS handshake timeout|error during connect|no space left on device|connection reset by peer|unable to lease content|lease does not exist/i.test(value)) return 'docker_infrastructure';
  // The macOS BSD sed expression used by older snapshots and the explicit
  // grader toolchain marker are host/toolchain failures, never Claude output.
  if (/sed:\s*1:[^\n]*(?:RE error|repetition-operator operand invalid)|FAILURE_CLASS=docker_toolchain|\/bin\/bash:\s*line\s+\d+:\s*go:\s*command not found/i.test(value)) return 'docker_infrastructure';
  // A repository clone can fail after the transport has started without
  // emitting the older connection diagnostics. Git's fetch-pack/early-EOF
  // messages are still transport failures and must not consume a Claude fix
  // attempt.
  if (/(?:Connection closed by|Connection timed out|Connection reset by|Could not resolve host|Failed to connect to)\s+[^\n]*(?:port\s+\d+)?|fatal:\s+Could not read from remote repository|fetch-pack:\s+unexpected disconnect|fatal:\s+early EOF|fatal:\s+fetch-pack:\s+invalid index-pack output|(?:error:\s+)?RPC failed;\s*curl\s+\d+|remote end hung up unexpectedly/i.test(value)) return 'git_infrastructure';
  if (/publish_test_model_fix\.sh[^\n]*Terminated(?::\s*\d+)?[^\n]*git\s+(?:clone|push|fetch)\b/i.test(value)) return 'git_infrastructure';
  if (/FAILURE_CLASS=git_publication|validated checkpoint Git publication failed|(?:green_branch|red_branch|test_model_fix_branch) must be bug/i.test(value)) return 'git_infrastructure';
  if (/invalid_json_schema|Invalid schema for response_format|response_format.*schema/i.test(value)) return 'codex_infrastructure';
  if (/post-fix compile preflight failed[\s\S]*go\.mod requires go >= [^\n]+\(running go [^\n]+GOTOOLCHAIN=local\)|FAST_VERIFICATION_GATE: fixed Go [^\n]+ is not installed locally/i.test(value)) return 'runner_infrastructure';
  if (/ENOENT[\s\S]*(?:trajectory|runner-manifest|mutation-audit|claude-v4-hook|run_docker\.sh)|run_one_claude\.sh[^\n]*syntax error|runner-snapshots\/[^\n]+\.sh:\s*line\s+\d+:\s*(?:rg:\s*command not found|[^\n]*Permission denied)/i.test(value)) return 'runner_infrastructure';
  if (/trajectory already exists|bug_index must be an integer from 1 to 5|bug_index must be a positive integer|Claude task runner already active/i.test(value)) return 'runner_infrastructure';
  if (/go-task-git-publish[^\n]*(?:Permission denied|Operation not permitted)|(?:Permission denied|Operation not permitted)[\s\S]*go-task-git-publish/i.test(value)) return 'git_infrastructure';
  // The progress watcher snapshots a live Claude workspace while the model
  // may rename or remove vendor files. These transient ENOENT messages and a
  // real-file-progress/child-event timeouts are runner faults, not a failed
  // code fix. Older pipeline processes can still emit the child-event wording
  // after the default watchdog has been raised for newly started runners.
  if (/真实文件进展|未产生子进程事件|运行超过\s*\d+\s*秒总上限|go-task-claude\.[^\s/]+\/workspace\/[^\n]*No such file or directory|runner-snapshots\/[^\n]+\.sh: line \d+: [^\n]*\/workspace\/[^\n]*No such file or directory/i.test(value)) return 'runner_infrastructure';
  return 'model_attempt';
}

export function isSystemTrajectoryFailure(message = '') {
  return classifyTrajectoryAttemptFailure(message) !== 'model_attempt';
}

async function walkTestFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'vendor') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('_test.go')) files.push(absolute);
    }
  }
  await visit(root);
  return files;
}

async function atomicWrite(filename, content) {
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const existing = await fsp.stat(filename).catch(() => null);
  await fsp.writeFile(temporary, content, 'utf8');
  if (existing) await fsp.chmod(temporary, existing.mode & 0o777);
  await fsp.rename(temporary, filename);
}

export async function repairGoldTestCollision(taskDir, workspace) {
  const contextPath = path.join(taskDir, 'grader/v4-context.json');
  const context = JSON.parse(await fsp.readFile(contextPath, 'utf8'));
  const currentName = String(context.gold_test_name || '');
  if (!/^Test[A-Za-z0-9_]+$/.test(currentName)) {
    throw new Error(`grader context has invalid gold_test_name: ${currentName || '(empty)'}`);
  }

  const declaration = new RegExp(`\\bfunc\\s+${escapeRegExp(currentName)}\\s*\\(`);
  const workspaceFiles = await walkTestFiles(workspace);
  const collisions = [];
  for (const filename of workspaceFiles) {
    const content = await fsp.readFile(filename, 'utf8');
    if (declaration.test(content)) collisions.push(path.relative(workspace, filename));
  }
  if (!collisions.length) return { ok: true, repaired: false, testName: currentName, collisions: [] };

  const publicMetadata = JSON.parse(await fsp.readFile(path.join(taskDir, 'public.json'), 'utf8'));
  const bugIndex = Number(publicMetadata.bug_index || 1);
  const bugId = String(publicMetadata.bug_id || path.basename(taskDir));
  let nextName = namespacedGoldTestName(bugIndex, bugId, currentName);
  if (nextName === currentName) {
    const digest = crypto.createHash('sha256').update(`${bugId}:${currentName}:collision`).digest('hex').slice(0, 6);
    nextName = `${currentName}_${digest}`;
  }

  const listedFiles = (await fsp.readFile(path.join(taskDir, 'grader/test-files.txt'), 'utf8'))
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const changedGoldFiles = [];
  for (const relative of listedFiles) {
    const filename = path.join(taskDir, 'grader/gold-tests', relative);
    const content = await fsp.readFile(filename, 'utf8');
    if (!declaration.test(content)) continue;
    await atomicWrite(filename, content.replace(declaration, `func ${nextName}(`));
    changedGoldFiles.push(relative);
  }
  if (changedGoldFiles.length !== 1) {
    throw new Error(`GRADER_COLLISION cannot safely repair ${currentName}: declarations=${changedGoldFiles.length}`);
  }

  const targetPath = path.join(taskDir, 'grader/run_target.sh');
  const target = await fsp.readFile(targetPath, 'utf8');
  if (!target.includes(currentName)) throw new Error(`GRADER_COLLISION target script does not reference ${currentName}`);
  await atomicWrite(targetPath, target.split(currentName).join(nextName));

  const namespace = goldTestNamespace(bugIndex, bugId);
  const nextContext = { ...context, gold_test_name: nextName, gold_test_namespace: namespace.prefix };
  await atomicWrite(contextPath, `${JSON.stringify(nextContext, null, 2)}\n`);
  await atomicWrite(path.join(taskDir, 'grader/namespace.json'), `${JSON.stringify({
    policy: 'isolated-gold-test-name-v1',
    prefix: namespace.prefix,
    test_name: nextName,
    repaired_from: currentName,
    repaired_collision_files: collisions,
  }, null, 2)}\n`);

  return { ok: true, repaired: true, testName: nextName, previousTestName: currentName, collisions, changedGoldFiles };
}
