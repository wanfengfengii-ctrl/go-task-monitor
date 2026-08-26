#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseMutationAudit } from '../src/trajectory-audit.js';
import {
  commandMasksExit,
  diagnosisBashMutationIntents,
  parseTrajectoryJson,
  sourceInspectionKind,
  validateTrajectoryEvents,
} from '../src/trajectory-file-validator.js';

const SOURCE_EXTENSION_PATTERN = /\.(?:go|py|pyw|sh|bash|zsh|js|jsx|ts|tsx|c|cc|cpp|h|hpp|rs|java|kt)$/i;
const DECISIVE_GO_VALIDATION_PATTERN = /\bgo\s+(?:test|vet)\b|\bstaticcheck\b|\bgofmt\s+-(?:d|l)\b/i;
const EXPLORATION_TOOLS = new Set(['Read', 'Grep', 'Glob']);

function digestFile(filename) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filename));
  return hash.digest('hex');
}

async function snapshotTree(root, prefix, { sourceOnly = false } = {}) {
  const files = {};
  if (!root) return files;
  async function visit(directory, relative = '') {
    let children;
    try {
      children = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (['.git', 'gocache', 'gomodcache', 'gotmp', 'trajectory'].includes(child.name)) continue;
      if (prefix === 'temp-source' && !relative && ['workspace', 'pristine', 'claude-config', 'empty-gh-config'].includes(child.name)) continue;
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) await visit(absolute, childRelative);
      else if (child.isFile() && (!sourceOnly || SOURCE_EXTENSION_PATTERN.test(child.name))) {
        try {
          files[`${prefix}/${childRelative}`] = digestFile(absolute);
        } catch {}
      }
    }
  }
  await visit(root);
  return files;
}

async function readInput() {
  let content = '';
  for await (const chunk of process.stdin) content += chunk;
  return content.trim() ? JSON.parse(content) : {};
}

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`);
}

function blockStop(reason) {
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
}

function eventSessionId(event) {
  return event?.sessionId || event?.session_id || '';
}

function immutableBugfixTarget(target, workspaceRoot) {
  const value = String(target || '').trim();
  if (!value || !workspaceRoot) return '';
  const absolute = path.isAbsolute(value) ? path.normalize(value) : path.resolve(workspaceRoot, value);
  const relative = path.relative(workspaceRoot, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return '';
  const portable = relative.split(path.sep).join('/');
  return /(?:^|\/)[^/]*_test\.go$/i.test(portable) || /(?:^|\/)testdata(?:\/|$)/i.test(portable)
    ? portable
    : '';
}

function temporaryBugfixHelperTarget(target, workspaceRoot) {
  const value = String(target || '').trim();
  if (!value || !workspaceRoot) return '';
  const absolute = path.isAbsolute(value) ? path.normalize(value) : path.resolve(workspaceRoot, value);
  const relative = path.relative(workspaceRoot, absolute);
  const insideWorkspace = relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const portable = (insideWorkspace ? relative : absolute).split(path.sep).join('/');
  const helperLike = /(?:^|\/)(?:cmd\/)?(?:verify|repro|debug|scratch|tmp)[^/]*(?:\/|$)/i.test(portable);
  if (!helperLike) return '';
  if (insideWorkspace) return fs.existsSync(absolute) ? '' : portable;
  return /^\/(?:tmp|private\/tmp|var\/folders)(?:\/|$)/i.test(portable) ? portable : '';
}

function directMutationTargets(toolName, toolInput) {
  if (!['Write', 'Edit', 'NotebookEdit', 'MultiEdit', 'apply_patch', 'ApplyPatch'].includes(toolName)) return [];
  const candidates = [
    toolInput.file_path,
    toolInput.filePath,
    toolInput.path,
    toolInput.notebook_path,
    toolInput.notebookPath,
  ];
  const patchText = String(toolInput.patch || toolInput.input || '');
  for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) candidates.push(match[1]);
  return candidates.map((value) => String(value || '').trim()).filter(Boolean);
}

async function withExplorationStateLock(statePath, action) {
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await fsp.mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fsp.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fsp.rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error('exploration state lock timeout');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await action();
  } finally {
    await fsp.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function readExplorationState(statePath) {
  try {
    return JSON.parse(await fsp.readFile(statePath, 'utf8'));
  } catch {
    return {};
  }
}

async function writeExplorationState(statePath, state) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, statePath);
}

async function enforceSourceFirstInspection(input, event, toolName, toolInput) {
  if (!['bugfix', 'diagnosis'].includes(String(process.env.V4_TASK_TYPE || ''))) return false;
  const statePath = String(process.env.V4_SOURCE_FIRST_STATE || '');
  if (!statePath) return false;
  const inspection = sourceInspectionKind(toolName, toolInput);
  if (event === 'PostToolUse' && inspection.kind === 'implementation') {
    await withExplorationStateLock(statePath, async () => {
      const state = await readExplorationState(statePath);
      await writeExplorationState(statePath, {
        ...state,
        implementationReadObserved: true,
        evidence: inspection.evidence,
        updatedAt: new Date().toISOString(),
      });
    });
    return false;
  }
  if (event !== 'PreToolUse' || inspection.kind !== 'test') return false;
  if (String(process.env.V4_TASK_TYPE || '') === 'diagnosis') {
    const reason = `Diagnosis 必须仅从生产实现和公开运行结果完成定位，禁止读取测试源码：${inspection.evidence || '测试路径'}；可以运行题面明确给出的公开复现命令，但不要打开、搜索或列举测试文件`;
    await appendAuditRecord(input, { permissionDecision: 'deny', permissionReason: reason });
    deny(reason);
    return true;
  }
  const state = await readExplorationState(statePath);
  if (state.implementationReadObserved === true) return false;
  const reason = `禁止在读取直接调用链的生产实现前检查测试源码：${inspection.evidence || '测试路径'}；请先从用户给出的端点、命令或状态差异定位并读取相关生产文件`;
  await appendAuditRecord(input, { permissionDecision: 'deny', permissionReason: reason });
  deny(reason);
  return true;
}

async function applyBugfixExplorationBudget(toolName) {
  if (!EXPLORATION_TOOLS.has(toolName)) return false;
  const statePath = String(process.env.V4_EXPLORATION_STATE || '');
  const sourceProgressPath = String(process.env.V4_SOURCE_PROGRESS_STATE || '');
  const editRequiredPath = String(process.env.V4_EDIT_REQUIRED_STATE || '');
  const configuredLimit = Number(process.env.V4_EXPLORATION_LIMIT || 10);
  const limit = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 10;
  if (!statePath || (sourceProgressPath && fs.existsSync(sourceProgressPath))) return false;
  return withExplorationStateLock(statePath, async () => {
    const state = await readExplorationState(statePath);
    if (state.productionEditObserved === true) return false;
    if (state.finalReminderIssued === true) {
      deny('修复前探索已关闭；下一步只允许使用 Edit/Write 修改已定位的生产文件');
      return true;
    }
    const count = Number(state.count || 0) + 1;
    const firstReminderIssued = state.reminderIssued === true || Number(state.remindersIssued || 0) >= 1;
    const finalReminderThreshold = limit + 2;
    const issueFirstReminder = !firstReminderIssued && count > limit;
    const issueFinalReminder = firstReminderIssued && count > finalReminderThreshold;
    const next = {
      ...state,
      count,
      ...(firstReminderIssued || issueFirstReminder ? { reminderIssued: true, remindersIssued: 1 } : {}),
      ...(issueFinalReminder ? { finalReminderIssued: true, remindersIssued: 2 } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeExplorationState(statePath, next);
    if ((count >= limit || issueFinalReminder) && editRequiredPath) {
      await writeExplorationState(editRequiredPath, {
        requiredAt: new Date().toISOString(),
        reason: 'exploration_budget_exhausted',
        explorationCount: count,
      });
    }
    if (!issueFirstReminder && !issueFinalReminder) return false;
    deny(issueFinalReminder
      ? `这是修复前探索的最后提醒：已额外允许 2 次定位读取，仍未修改生产源码。下一步必须直接使用 Edit/Write 修改已定位的生产文件，否则会话将因无源码进展被回收`
      : `修复前的源码探索已达到 ${limit} 次；你已经拥有足够上下文，请停止继续浏览，下一步直接使用 Edit/Write 对已定位的生产文件实施最小修复`);
    return true;
  });
}

async function enforceBugfixEditOnlyBash(toolName) {
  if (toolName !== 'Bash') return false;
  const statePath = String(process.env.V4_EXPLORATION_STATE || '');
  const sourceProgressPath = String(process.env.V4_SOURCE_PROGRESS_STATE || '');
  if (!statePath || (sourceProgressPath && fs.existsSync(sourceProgressPath))) return false;
  return withExplorationStateLock(statePath, async () => {
    const state = await readExplorationState(statePath);
    if (state.productionEditObserved !== true && state.finalReminderIssued === true) {
      deny('修复前探索已关闭；请停止使用 Bash 继续浏览或验证，下一步直接使用 Edit/Write 修改生产文件');
      return true;
    }
    if (state.productionEditObserved !== true && state.reminderIssued === true) {
      deny('修复前探索已达到上限；不要改用 Bash 继续浏览，如确有必要请只使用剩余的 2 次定向 Read/Grep/Glob，然后直接 Edit/Write');
      return true;
    }
    return false;
  });
}

async function markBugfixProductionEdit(toolName, toolInput) {
  if (!['Write', 'Edit', 'NotebookEdit', 'MultiEdit', 'apply_patch', 'ApplyPatch'].includes(toolName)) return;
  const workspaceRoot = String(process.env.V4_WORKSPACE_ROOT || '');
  const statePath = String(process.env.V4_EXPLORATION_STATE || '');
  const editRequiredPath = String(process.env.V4_EDIT_REQUIRED_STATE || '');
  if (!workspaceRoot || !statePath) return;
  const editsProductionWorkspace = directMutationTargets(toolName, toolInput).some((target) => {
    const absolute = path.isAbsolute(target) ? path.normalize(target) : path.resolve(workspaceRoot, target);
    const relative = path.relative(workspaceRoot, absolute);
    return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative) && !immutableBugfixTarget(target, workspaceRoot));
  });
  if (!editsProductionWorkspace) return;
  await withExplorationStateLock(statePath, async () => {
    const state = await readExplorationState(statePath);
    await writeExplorationState(statePath, {
      ...state,
      productionEditObserved: true,
      updatedAt: new Date().toISOString(),
    });
    if (editRequiredPath) await fsp.rm(editRequiredPath, { force: true }).catch(() => {});
  });
}

function stopRepairMessage(errorCodes) {
  const actions = [];
  if (errorCodes.has('green-after-fix')) actions.push('重新直接运行你新增的 TestModel_ 目标测试并确认成功');
  if (errorCodes.has('full-after-fix')) actions.push('单独运行 go test ./... -count=1 并确认成功');
  return `当前修复尚缺少可验收的修复后证据：${actions.join('；')}。每次 Bash 调用只能包含一条验证命令，不得使用管道、输出重定向、echo/printf 状态打印、&&/||、分号命令链或回退命令。完成后再给出最终回复。`;
}

async function appendAuditRecord(input, { permissionDecision = '', permissionReason = '' } = {}) {
  const event = input.hook_event_name || input.hookEventName || 'ManualSnapshot';
  const toolName = input.tool_name || input.toolName || '';
  const [workspaceFiles, tempSourceFiles] = await Promise.all([
    snapshotTree(process.env.V4_WORKSPACE_ROOT || '', 'workspace'),
    snapshotTree(process.env.V4_TEMP_ROOT || '', 'temp-source', { sourceOnly: true }),
  ]);
  const record = {
    event,
    tool_use_id: input.tool_use_id || input.toolUseId || '',
    tool_name: toolName,
    files: { ...workspaceFiles, ...tempSourceFiles },
  };
  if (permissionDecision) record.permission_decision = permissionDecision;
  if (permissionReason) record.permission_reason = permissionReason;
  await fsp.appendFile(process.env.V4_AUDIT_LOG, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

async function checkBugfixStop(input) {
  if (input.stop_hook_active === true || input.stopHookActive === true) return;
  const transcriptPath = String(input.transcript_path || input.transcriptPath || '');
  if (!transcriptPath) return;
  const [transcriptContent, auditContent] = await Promise.all([
    fsp.readFile(transcriptPath, 'utf8'),
    fsp.readFile(process.env.V4_AUDIT_LOG, 'utf8'),
  ]);
  const events = parseTrajectoryJson(transcriptContent);
  const auditRecords = parseMutationAudit(auditContent);
  const currentSnapshot = await appendAuditRecord({ hook_event_name: 'StopEvidenceSnapshot' });
  const finalSnapshot = { ...currentSnapshot, event: 'V4Final' };
  const sessionId = String(input.session_id || input.sessionId || events.map(eventSessionId).find(Boolean) || '00000000-0000-0000-0000-000000000000');
  const validation = validateTrajectoryEvents(events, {
    filename: `trajectory_${sessionId}.jsonl`,
    taskType: 'bugfix',
    executionPolicyVersion: 4,
    workspaceRoot: process.env.V4_WORKSPACE_ROOT || '',
    auditRecords: [...auditRecords, finalSnapshot],
  });
  const repairable = new Set(validation.errors
    .map((item) => item.code)
    .filter((code) => code === 'green-after-fix' || code === 'full-after-fix'));
  if (repairable.size) blockStop(stopRepairMessage(repairable));
}

async function main() {
  const input = await readInput();
  const event = input.hook_event_name || input.hookEventName || 'ManualSnapshot';
  const toolName = input.tool_name || input.toolName || '';
  const toolInput = input.tool_input || input.toolInput || {};
  const taskType = process.env.V4_TASK_TYPE || '';
  const command = String(toolInput.command || '');
  if (taskType === 'bugfix' && event === 'Stop') {
    try {
      await checkBugfixStop(input);
    } catch (error) {
      process.stderr.write(`V4 Stop evidence check deferred to final validator: ${error.message}\n`);
    }
    return;
  }
  if (await enforceSourceFirstInspection(input, event, toolName, toolInput)) return;
  if (taskType === 'bugfix' && event === 'PreToolUse' && EXPLORATION_TOOLS.has(toolName)) {
    await applyBugfixExplorationBudget(toolName);
    return;
  }
  if (taskType === 'bugfix' && event === 'PreToolUse' && toolName === 'Bash') {
    if (await enforceBugfixEditOnlyBash(toolName)) return;
  }
  if (taskType === 'bugfix' && event === 'PostToolUse') {
    await markBugfixProductionEdit(toolName, toolInput);
  }
  if (['bugfix', 'diagnosis'].includes(taskType) && event === 'PreToolUse' && toolName === 'Bash' && DECISIVE_GO_VALIDATION_PATTERN.test(command) && commandMasksExit(command)) {
    const reason = '该验证命令会掩盖真实退出码；请在单独的 Bash 调用中直接执行 go test、go vet、staticcheck 或 gofmt 检查，不要使用 head/tail/tee 管道或追加状态打印';
    await appendAuditRecord(input, { permissionDecision: 'deny', permissionReason: reason });
    deny(reason);
    return;
  }
  if (taskType === 'bugfix' && event === 'PreToolUse') {
    const workspaceRoot = process.env.V4_WORKSPACE_ROOT || '';
    const directTargets = directMutationTargets(toolName, toolInput);
    const bashIntents = toolName === 'Bash'
      ? diagnosisBashMutationIntents(command, workspaceRoot)
      : [];
    const temporaryHelper = [...directTargets, ...bashIntents.map((intent) => intent.target)]
      .map((target) => temporaryBugfixHelperTarget(target, workspaceRoot))
      .find(Boolean);
    if (temporaryHelper) {
      const reason = `bugfix 修复阶段禁止创建临时验证 helper、脚本或入口：${temporaryHelper}；请使用现有测试或聚焦包命令验证生产补丁`;
      await appendAuditRecord(input, { permissionDecision: 'deny', permissionReason: reason });
      deny(reason);
      return;
    }
    const directTarget = directTargets
      .map((target) => immutableBugfixTarget(target, workspaceRoot))
      .find(Boolean);
    const bashTarget = toolName === 'Bash'
      ? bashIntents
        .map((intent) => immutableBugfixTarget(intent.target, workspaceRoot))
        .find(Boolean)
      : '';
    const immutableTarget = directTarget || bashTarget;
    if (immutableTarget) {
      const reason = `bugfix 修复阶段禁止创建、修改或删除测试文件：${immutableTarget}；请只修改生产代码`;
      await appendAuditRecord(input, { permissionDecision: 'deny', permissionReason: reason });
      deny(reason);
      return;
    }
  }
  if (taskType === 'diagnosis' && event === 'PreToolUse') {
    if (['Write', 'Edit', 'NotebookEdit', 'MultiEdit', 'apply_patch', 'ApplyPatch'].includes(toolName)) {
      const reason = 'diagnosis 任务全程禁止创建或修改任何文件';
      await appendAuditRecord(input, { permissionDecision: 'deny', permissionReason: reason });
      deny(reason);
      return;
    }
    const writeIntents = toolName === 'Bash'
      ? diagnosisBashMutationIntents(command, process.env.V4_WORKSPACE_ROOT || '')
      : [];
    if (writeIntents.length) {
      const first = writeIntents[0];
      const reason = `diagnosis 任务禁止任何文件或持久配置写入（${first.kind}: ${first.target}）`;
      await appendAuditRecord(input, { permissionDecision: 'deny', permissionReason: reason });
      deny(reason);
      return;
    }
  }
  await appendAuditRecord(input);
}

main().catch((error) => {
  process.stderr.write(`V4 hook failed: ${error.message}\n`);
  process.exitCode = 2;
});
