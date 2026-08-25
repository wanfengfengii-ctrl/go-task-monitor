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
  validateTrajectoryEvents,
} from '../src/trajectory-file-validator.js';

const SOURCE_EXTENSION_PATTERN = /\.(?:go|py|pyw|sh|bash|zsh|js|jsx|ts|tsx|c|cc|cpp|h|hpp|rs|java|kt)$/i;
const DECISIVE_GO_VALIDATION_PATTERN = /\bgo\s+(?:test|vet)\b|\bstaticcheck\b|\bgofmt\s+-(?:d|l)\b/i;

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
  if (['bugfix', 'diagnosis'].includes(taskType) && event === 'PreToolUse' && toolName === 'Bash' && DECISIVE_GO_VALIDATION_PATTERN.test(command) && commandMasksExit(command)) {
    const reason = '该验证命令会掩盖真实退出码；请在单独的 Bash 调用中直接执行 go test、go vet、staticcheck 或 gofmt 检查，不要使用 head/tail/tee 管道或追加状态打印';
    await appendAuditRecord(input, { permissionDecision: 'deny', permissionReason: reason });
    deny(reason);
    return;
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
