import path from 'node:path';
import { analyzeMutationAudit } from './trajectory-audit.js';
import { isClaudeInternalUserEvent } from './trajectory-v4.js';

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRAJECTORY_FILENAME_PATTERN = /^trajectory_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl?$/i;
const DIRECT_WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'apply_patch', 'ApplyPatch']);
const PROTECTED_PATH_PATTERN = /(?:^|\/)(?:gold|grader)(?:\/|$)/i;
const TEMP_PATH_PATTERN = /^\/(?:tmp|private\/tmp|var\/folders)(?:\/|$)/;
const ROLLBACK_PATTERN = /\bgit\s+(?:checkout|restore|revert|reset)\b|\b(?:cp|mv)\b[^\n]*(?:pristine|backup|original|\.bak)\b|reintroduc|buggy version|restored fixed/i;
const STATIC_CHECK_PATTERN = /\bgo\s+vet\b|\bstaticcheck\b|\bgofmt\s+-(?:d|l)\b|\bgit\s+diff\s+--check\b/i;
const TARGET_TEST_PATTERN = /run_target\.sh|\bgo\s+test\b[^\n]*(?:-run\b|-run=)/i;
const DIAGNOSIS_REPRO_PATTERN = /\bgo\s+(?:test|run|build)\b|\bcurl\b[^\n]*https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\b|(?:^|[;&|]\s*)(?:\.\/|\/)[\w./-]+(?:\s|$)|\b(?:make|just)\s+(?:test|check|repro|verify)\b|\b(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|check|repro|verify))\b|\bjournalctl\b|\b(?:cat|rg|grep|sed|tail)\b[^\n]*(?:\.log\b|\.trace\b|stderr|stdout)/i;
const FULL_TEST_PATTERN = /run_full\.sh|\bgo\s+test\b[^\n]*(?:\.\/\.\.\.|(?:^|\s)\.\s|(?:^|\s)\.\/?(?:\s|$))/i;
const REQUIRED_VALIDATION_PATTERN = /run_(?:target|full|static)\.sh|\bgo\s+(?:test|vet)\b|\bstaticcheck\b|\bgofmt\s+-(?:d|l)\b/i;
const PIPE_SINK_PATTERN = /(?:^|[^|])\|(?!\|)\s*(?:head|tail|tee)\b/i;
const MASKED_SUFFIX_PATTERN = /;\s*(?:echo|printf)\b[^\n]*(?:\$\?|EXIT)|\|\|\s*(?:true|:)\b/i;
const TEST_FILE_PATTERN = /_test\.go$/i;
const TEST_SOURCE_PATH_PATTERN = /(?:^|\/)(?:testdata)(?:\/|$)|(?:^|\/)[^/]*_test\.go$|(?:^|\/)[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const IMPLEMENTATION_SOURCE_PATH_PATTERN = /(?:\.go|\.mod|\.sum|\.py|\.pyw|\.sh|\.bash|\.zsh|\.js|\.jsx|\.ts|\.tsx|\.c|\.cc|\.cpp|\.h|\.hpp|\.rs|\.java|\.kt|\.ya?ml|\.json|\.toml|Dockerfile)$/i;
const SOURCE_INSPECTION_COMMAND_PATTERN = /\b(?:cat|sed|rg|grep|head|tail|awk)\b/i;

function issue(level, code, message, evidence = '') {
  return { level, code, message, ...(evidence ? { evidence } : {}) };
}

function contentBlocks(event) {
  return Array.isArray(event?.message?.content) ? event.message.content : [];
}

function humanUserText(event) {
  if (event?.type !== 'user') return '';
  const content = event?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const text = content.filter((block) => block?.type === 'text' && String(block.text || '').trim());
  return text.length && content.every((block) => block?.type === 'text')
    ? text.map((block) => String(block.text).trim()).join('\n').trim()
    : '';
}

function finalAssistantText(events) {
  const event = events.findLast((item) => item?.type === 'assistant' && contentBlocks(item).some((block) => block?.type === 'text' && String(block.text || '').trim()));
  return contentBlocks(event).filter((block) => block?.type === 'text').map((block) => String(block.text || '')).join('\n').trim();
}

export function commandMasksExit(command) {
  const value = String(command || '');
  const hasUnsafePipe = PIPE_SINK_PATTERN.test(value) && !/(?:set\s+-o\s+pipefail|set\s+-[^\n;]*o[^\n;]*pipefail)/i.test(value);
  return hasUnsafePipe || MASKED_SUFFIX_PATTERN.test(value);
}

function isFullTestCommand(command) {
  const value = String(command || '');
  return FULL_TEST_PATTERN.test(value) && (!TARGET_TEST_PATTERN.test(value) || /run_full\.sh/i.test(value));
}

function toolResultText(result) {
  const content = result?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => typeof item === 'string' ? item : item?.text || '').join('\n');
  return String(content || '');
}

function toolOutcome(result) {
  if (!result) return 'missing';
  const exitMatches = [...toolResultText(result).matchAll(/(?:^|\s)EXIT\s*=\s*(-?\d+)\b/gim)];
  if (exitMatches.length) return Number(exitMatches.at(-1)[1]) === 0 ? 'success' : 'failure';
  return result.is_error === true ? 'failure' : 'success';
}

function eventSessionId(event) {
  return event?.sessionId || event?.session_id || '';
}

function eventCwd(event) {
  return typeof event?.cwd === 'string' ? event.cwd : '';
}

function stringInput(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  return String(input.command || input.file_path || input.path || input.notebook_path || '');
}

function directTarget(call) {
  const input = call.input;
  if (!input || typeof input !== 'object') return '';
  return String(input.file_path || input.path || input.notebook_path || '');
}

function commandWithoutTestExclusions(command) {
  return String(command || '')
    .replace(/\|\s*(?:\S*\/)?(?:grep|rg)\b(?=[^|\n]*(?:\s--invert-match\b|\s-[A-Za-z]*v[A-Za-z]*\b))[^|\n]*/gi, '')
    .replace(/\s+(?:-g|--glob)(?:=|\s+)(["'])![^"']*(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?|testdata)[^"']*\1/gi, '')
    .replace(/\s+(?:!|-not)\s+-name\s+(?:"[^"]*(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?)[^"]*"|'[^']*(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?)[^']*'|\S*(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?)\S*)/gi, '');
}

export function sourceInspectionKind(toolName, toolInput = {}) {
  const call = { name: String(toolName || ''), input: toolInput || {} };
  const direct = directTarget(call).split(path.sep).join('/');
  const testTarget = (value) => TEST_SOURCE_PATH_PATTERN.test(String(value || '').split(path.sep).join('/'));
  const implementationTarget = (value) => {
    const target = String(value || '').split(path.sep).join('/');
    return Boolean(target && !testTarget(target) && IMPLEMENTATION_SOURCE_PATH_PATTERN.test(target));
  };

  if (call.name === 'Read') {
    if (testTarget(direct)) return { kind: 'test', evidence: direct };
    if (implementationTarget(direct)) return { kind: 'implementation', evidence: direct };
    return { kind: '', evidence: direct };
  }
  if (call.name === 'Glob') {
    const pattern = String(call.input?.pattern || call.input?.glob || '');
    return TEST_SOURCE_PATH_PATTERN.test(pattern) || /_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?/i.test(pattern)
      ? { kind: 'test', evidence: pattern }
      : { kind: '', evidence: pattern };
  }
  if (call.name === 'Grep') {
    const target = String(call.input?.path || call.input?.file_path || call.input?.filePath || '');
    const pattern = String(call.input?.pattern || '');
    if (testTarget(target) || /\bTest[A-Z][A-Za-z0-9_]*\b/.test(pattern)) return { kind: 'test', evidence: `${pattern} ${target}`.trim() };
    if (implementationTarget(target)) return { kind: 'implementation', evidence: target };
    return { kind: '', evidence: `${pattern} ${target}`.trim() };
  }
  if (call.name !== 'Bash') return { kind: '', evidence: direct };

  const command = String(call.input?.command || '');
  if (!SOURCE_INSPECTION_COMMAND_PATTERN.test(command)) return { kind: '', evidence: command };
  const inspectionCommand = commandWithoutTestExclusions(command).trim();
  if (TEST_SOURCE_PATH_PATTERN.test(inspectionCommand)
    || /_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?/i.test(inspectionCommand)
    || /\b(?:rg|grep)\b[^\n]*\bTest[A-Z][A-Za-z0-9_]*\b/.test(inspectionCommand)) {
    return { kind: 'test', evidence: command.slice(0, 320) };
  }
  if (IMPLEMENTATION_SOURCE_PATH_PATTERN.test(inspectionCommand)) {
    return { kind: 'implementation', evidence: command.slice(0, 320) };
  }
  return { kind: '', evidence: command.slice(0, 320) };
}

function cleanShellToken(token) {
  return String(token || '').trim().replace(/^["']|["']$/g, '').replace(/[),]+$/g, '');
}

function commandCwd(command, fallback) {
  const variables = new Map();
  for (const assignment of String(command).matchAll(/(?:^|[;\n]\s*)([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
    variables.set(assignment[1], assignment[2] || assignment[3] || assignment[4] || '');
  }
  const match = String(command).match(/(?:^|[;&|\n]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  let value = cleanShellToken(match?.[1] || match?.[2] || match?.[3]);
  const variableMatch = value.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (variableMatch) value = variables.get(variableMatch[1]) || '';
  if (!value || value.includes('$')) return fallback;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(fallback || '.', value);
}

function resolveMutationTarget(target, cwd) {
  const value = cleanShellToken(target);
  if (!value || value === '.' || value === './' || value.includes('$') || value.includes('*')) return '';
  if (/^(?:-|https?:|[0-9]+$|&[0-9]+$)/.test(value)) return '';
  if (/^\/dev\/(?:null|stdout|stderr|fd\/\d+)$/i.test(value)) return '';
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd || '.', value));
}

function words(value) {
  const matches = String(value).match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  return matches.map(cleanShellToken);
}

function isShellPositionQuoted(value, position) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < position; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"') quote = character;
  }
  return Boolean(quote);
}

function maskHeredocBodies(command) {
  const lines = String(command).split('\n');
  const masked = [];
  let heredoc = null;
  let offset = 0;

  for (const line of lines) {
    if (heredoc) {
      const comparable = (heredoc.stripTabs ? line.replace(/^\t+/, '') : line).replace(/\r$/, '');
      masked.push(' '.repeat(line.length));
      if (comparable === heredoc.delimiter) heredoc = null;
      offset += line.length + 1;
      continue;
    }

    masked.push(line);
    for (const match of line.matchAll(/<<(-?)\s*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z_][A-Za-z0-9_]*))/g)) {
      const operatorIndex = offset + (match.index || 0);
      if (line[(match.index || 0) + 2] === '<' || isShellPositionQuoted(command, operatorIndex)) continue;
      heredoc = {
        delimiter: match[2] || match[3] || match[4],
        stripTabs: match[1] === '-',
      };
      break;
    }
    offset += line.length + 1;
  }
  return masked.join('\n');
}

function lastPathWord(segment) {
  const candidates = words(segment).filter((word) => (
    !word.startsWith('-')
    && !word.includes('$')
    && /(?:^|\/)[\w.-]+(?:\.[A-Za-z0-9_-]+)?$/.test(word)
  ));
  return candidates.at(-1) || '';
}

function bashMutations(command, fallbackCwd, toolOrdinal) {
  const mutations = [];
  const cwd = commandCwd(command, fallbackCwd);
  const add = (target, kind, excerpt) => {
    const resolved = resolveMutationTarget(target, cwd);
    if (resolved) mutations.push({ target: resolved, kind, toolOrdinal, evidence: excerpt.trim().slice(0, 240) });
  };

  for (const match of command.matchAll(/\bcp(?:\s+-[^\s]+)*\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    add(match[1], 'copy', match[0]);
  }
  for (const match of command.matchAll(/\bmv(?:\s+-[^\s]+)*\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    add(match[1], 'move', match[0]);
  }
  for (const match of command.matchAll(/\brm(?:\s+-[^\s]+)*\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    add(match[1], 'delete', match[0]);
  }
  const redirectSource = maskHeredocBodies(command);
  for (const match of redirectSource.matchAll(/(?:^|[\s])\d*(?:>>?|>\|)\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    const operatorIndex = (match.index || 0) + match[0].indexOf('>');
    if (isShellPositionQuoted(redirectSource, operatorIndex)) continue;
    add(match[1], 'redirect-write', match[0]);
  }
  for (const match of command.matchAll(/\btee(?:\s+-[^\s]+)*\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    add(match[1], 'tee-write', match[0]);
  }
  for (const match of command.matchAll(/\b(?:touch|mkdir|rmdir|truncate|unlink)(?:\s+-[^\s]+)*\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    add(match[1], 'filesystem-write', match[0]);
  }
  for (const match of command.matchAll(/\b(?:chmod|chown|chgrp)\b([^;&|\n]+)/g)) {
    add(lastPathWord(match[1]), 'metadata-write', match[0]);
  }
  for (const match of command.matchAll(/\b(?:install|ln)(?:\s+-[^\s]+)*\s+[^;&|\n]+/g)) {
    add(lastPathWord(match[0]), 'filesystem-write', match[0]);
  }
  for (const match of command.matchAll(/\bdd\b[^;&|\n]*\bof=("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    add(match[1], 'redirect-write', match[0]);
  }
  for (const match of command.matchAll(/\b(?:curl|wget)\b[^;&|\n]*\s(?:-o|--output|-O)\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    add(match[1], 'download-write', match[0]);
  }
  for (const match of command.matchAll(/\bgo\s+(?:build|test)\b[^;&|\n]*\s-o\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    add(match[1], 'compiler-output', match[0]);
  }
  for (const match of command.matchAll(/\bgofmt\s+-w\s+([^\n;&|]+)/g)) {
    for (const target of words(match[1]).filter((word) => !word.startsWith('-'))) add(target, 'gofmt-write', match[0]);
  }

  for (const segment of command.split(/&&|;|\n/)) {
    if (/\b(?:perl|sed)\b[^\n]*\s-(?:[^\s]*i[^\s]*)\b/i.test(segment)) {
      add(lastPathWord(segment), 'in-place-edit', segment);
    }
    if (/\bgit\s+(?:checkout|restore)\b/.test(segment)) {
      add(lastPathWord(segment), 'git-restore', segment);
    }
  }
  return mutations.filter((mutation, index, all) => all.findIndex((candidate) => (
    candidate.target === mutation.target && candidate.kind === mutation.kind
  )) === index);
}

// Diagnosis sessions are stricter than ordinary mutation accounting: even a
// denied or later-cleaned write command makes the submitted conversation look
// like a code-changing task. Keep this parser shared by the live hook, runner
// preflight, and trajectory validator so those three gates cannot drift.
export function diagnosisBashMutationIntents(command, fallbackCwd = '') {
  const value = String(command || '');
  const cwd = commandCwd(value, fallbackCwd);
  const intents = bashMutations(value, cwd, 0);
  const addSynthetic = (kind, evidence) => {
    intents.push({
      target: path.join(cwd || '/', `.diagnosis-${kind}`),
      kind,
      toolOrdinal: 0,
      evidence: String(evidence || '').trim().slice(0, 240),
    });
  };

  if (/\bgo\s+env\s+(?:-w|-u)\b/i.test(value)) addSynthetic('environment-write', value);
  if (/\b(?:git|npm|pnpm|yarn|pip|go)\s+config\s+(?:set|unset|add|replace|--global)\b/i.test(value)) addSynthetic('configuration-write', value);
  if (/\b(?:tar\b[^\n]*(?:\s-x|\s--extract)|unzip\b|patch\b|apply_patch\b)/i.test(value)) addSynthetic('archive-write', value);
  if (/\b(?:python(?:3)?|node|ruby)\b[^\n]*(?:\.write\s*\(|writeFile|write_text|write_bytes|open\s*\([^\n]*[,)]\s*['"]?[wax+]|fs\.(?:write|append|rename|unlink|rm|mkdir))/i.test(value)) {
    addSynthetic('script-write', value);
  }

  return intents.filter((intent, index, all) => all.findIndex((candidate) => (
    candidate.target === intent.target && candidate.kind === intent.kind
  )) === index);
}

function patchTargets(call, cwd, toolOrdinal) {
  const patch = typeof call.input === 'string' ? call.input : String(call.input?.patch || '');
  const targets = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const target = resolveMutationTarget(match[1], cwd);
    if (target) targets.push({ target, kind: call.name, toolOrdinal, evidence: match[0] });
  }
  return targets;
}

function isInside(root, target) {
  if (!root || !target) return false;
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasProtectedRead(call, workspaceRoot) {
  const target = directTarget(call);
  if (target && PROTECTED_PATH_PATTERN.test(target) && ['Read', ...DIRECT_WRITE_TOOLS].includes(call.name)) return target;
  if (call.name !== 'Bash') return '';
  const command = String(call.input?.command || '');
  const cwd = commandCwd(command, workspaceRoot);
  const inspection = /\b(?:cat|sed|grep|rg|less|cp|find|ls)\b/i.test(command);
  if (inspection && (PROTECTED_PATH_PATTERN.test(command) || PROTECTED_PATH_PATTERN.test(cwd))) return command.slice(0, 240);
  return '';
}

function extractToolActivity(events) {
  const uses = [];
  const results = [];
  let ordinal = 0;
  events.forEach((event, eventIndex) => {
    for (const block of contentBlocks(event)) {
      if (event?.type === 'assistant' && block?.type === 'tool_use') {
        ordinal += 1;
        uses.push({ ...block, eventIndex, ordinal });
      }
      if (event?.type === 'user' && block?.type === 'tool_result') {
        results.push({ ...block, eventIndex });
      }
    }
  });
  return { uses, results };
}

function permissionDeniedToolUseIds(events) {
  const ids = new Set();
  for (const event of events) {
    if (event?.type === 'system' && event?.subtype === 'permission_denied' && event?.tool_use_id) {
      ids.add(String(event.tool_use_id));
    }
    if (event?.type !== 'user') continue;
    for (const meta of Array.isArray(event.tool_result_meta) ? event.tool_result_meta : []) {
      if (meta?.non_execution_kind === 'permission-rule' && meta?.id) ids.add(String(meta.id));
    }
    for (const block of contentBlocks(event)) {
      const denied = block?.type === 'tool_result'
        && block?.is_error === true
        && /(?:Permission to use [\s\S]+ has been denied|diagnosis 任务禁止)/i.test(String(block.content || ''));
      if (denied && block.tool_use_id) ids.add(String(block.tool_use_id));
    }
  }
  return ids;
}

export function validateDiagnosisReadOnlyEvents(events, options = {}) {
  const errors = [];
  const warnings = [];
  const addError = (...args) => errors.push(issue('error', ...args));
  if (!Array.isArray(events)) {
    addError('diagnosis-readonly-shape', 'diagnosis 只读校验要求事件数组');
    return { ok: false, errors, warnings, stats: { mutationIntents: 0, auditMutations: 0 } };
  }

  const workspaceRoot = options.workspaceRoot
    || events.map(eventCwd).find((value) => value && path.basename(value) === 'workspace')
    || events.map(eventCwd).find(Boolean)
    || '';
  const { uses } = extractToolActivity(events);
  const intents = [];
  for (const call of uses) {
    if (DIRECT_WRITE_TOOLS.has(call.name) || call.name === 'MultiEdit') {
      const target = directTarget(call) || workspaceRoot || '/workspace';
      intents.push({
        toolOrdinal: call.ordinal,
        toolUseId: call.id || '',
        kind: call.name,
        target,
        evidence: `${call.name} ${target}`,
      });
      continue;
    }
    if (call.name !== 'Bash') continue;
    for (const intent of diagnosisBashMutationIntents(String(call.input?.command || ''), eventCwd(events[call.eventIndex]) || workspaceRoot)) {
      intents.push({ ...intent, toolOrdinal: call.ordinal, toolUseId: call.id || '' });
    }
  }
  if (intents.length) {
    addError(
      'diagnosis-write-command',
      `diagnosis 轨迹包含 ${intents.length} 条文件或持久配置写入命令；即使命令被拒绝或随后清理，也不能进入主轨迹`,
      intents.slice(0, 6).map((item) => `#${item.toolOrdinal} ${item.kind} ${item.target}`).join('; '),
    );
  }

  const auditedToolNames = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'apply_patch', 'ApplyPatch']);
  const auditRecords = Array.isArray(options.auditRecords) ? options.auditRecords : [];
  const requireAudit = options.requireAudit === true;
  const audit = auditRecords.length || requireAudit
    ? analyzeMutationAudit(auditRecords, {
      expectedToolUses: uses.filter((call) => auditedToolNames.has(call.name)),
      deniedToolUseIds: permissionDeniedToolUseIds(events),
    })
    : { ok: true, errors: [], warnings: [], mutations: [] };
  for (const message of audit.errors) addError('diagnosis-mutation-audit', message);
  for (const message of audit.warnings) warnings.push(issue('warning', 'diagnosis-mutation-audit', message));
  if (audit.mutations.length) {
    addError(
      'diagnosis-persistent-write',
      `diagnosis 外部快照检测到 ${audit.mutations.length} 处持久写入，工作区与临时源码必须全程不变`,
      audit.mutations.slice(0, 6).map((item) => `${item.toolUseId} ${item.filename}`).join('; '),
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: { mutationIntents: intents.length, auditMutations: audit.mutations.length },
  };
}

function verificationCalls(uses, toolResults) {
  const resultMap = new Map(toolResults.map((result) => [result.tool_use_id, result]));
  return uses.filter((call) => call.name === 'Bash').map((call) => ({
    ...call,
    command: String(call.input?.command || ''),
    result: resultMap.get(call.id),
    outcome: toolOutcome(resultMap.get(call.id)),
  }));
}

function relevantCodeRead(call, expectedFiles = []) {
  const names = expectedFiles.map((value) => path.basename(value)).filter(Boolean);
  if (call.name === 'Read') {
    const target = directTarget(call);
    return /\.go$/i.test(target) && (!names.length || names.some((name) => target.endsWith(name)));
  }
  if (call.name !== 'Bash') return false;
  const command = String(call.input?.command || '');
  if (!/\b(?:cat|sed|rg|grep|head|tail|awk)\b/i.test(command) || !/\.go\b/i.test(command)) return false;
  return !names.length || names.some((name) => command.includes(name));
}

function relevantImplementationRead(call, expectedFiles = []) {
  const names = expectedFiles.map((value) => path.basename(value)).filter(Boolean);
  const matchesExpected = (value) => !names.length || names.some((name) => String(value).includes(name));
  if (call.name === 'Read') {
    const target = directTarget(call);
    return matchesExpected(target) && /(?:\.go|\.mod|\.sum|\.ya?ml|\.json|\.toml|\.sh|Dockerfile)$/i.test(target);
  }
  if (call.name !== 'Bash') return false;
  const command = String(call.input?.command || '');
  return /\b(?:cat|sed|rg|grep|head|tail|awk)\b/i.test(command) && matchesExpected(command);
}

function diagnosisRootCauseEvidence(finalText, expectedFiles, expectedSymbols, mechanismKeywords) {
  return {
    missingFiles: expectedFiles.filter((value) => !finalText.includes(path.basename(value))),
    missingSymbols: expectedSymbols.filter((value) => !finalText.includes(value)),
    matchedKeywords: mechanismKeywords.filter((value) => finalText.includes(value)),
  };
}

export function validateTrajectoryIntegrityEvents(events, options = {}) {
  const filename = path.basename(options.filename || '');
  const filenameMatch = filename.match(TRAJECTORY_FILENAME_PATTERN);
  const errors = [];
  const warnings = [];
  const addError = (...args) => errors.push(issue('error', ...args));

  if (!Array.isArray(events)) {
    addError('json-shape', 'trajectory 正文必须能解析为事件数组');
    return { ok: false, errors, warnings, stats: { eventCount: 0 } };
  }
  if (!events.length) addError('empty', 'trajectory 事件数组不能为空');
  if (options.requireFilename !== false && !filenameMatch) addError('filename', '文件名必须为 trajectory_<session-id>.json 或 trajectory_<session-id>.jsonl');

  const invalidEventIndex = events.findIndex((event) => !event || typeof event !== 'object' || Array.isArray(event));
  if (invalidEventIndex >= 0) addError('event-shape', `第 ${invalidEventIndex + 1} 个事件不是 JSON 对象`);

  const seenEventUuids = new Set();
  const duplicateEventUuids = [];
  const brokenParentLinks = [];
  const externalRootParentLinks = [];
  let internalParentLinkSeen = false;
  events.forEach((event, index) => {
    const eventUuid = String(event?.uuid || '').trim();
    const parentUuid = String(event?.parentUuid || event?.parent_uuid || '').trim();
    if (parentUuid && seenEventUuids.has(parentUuid)) {
      internalParentLinkSeen = true;
    } else if (parentUuid) {
      // A native Claude transcript may begin below a session-root event that
      // lives outside the exported file. Only that first boundary is external;
      // unknown parents after the internal chain starts remain hard failures.
      if (!internalParentLinkSeen && externalRootParentLinks.length === 0) {
        externalRootParentLinks.push({ index, parentUuid });
      } else {
        brokenParentLinks.push({ index, parentUuid });
      }
    }
    if (!eventUuid) return;
    if (seenEventUuids.has(eventUuid)) duplicateEventUuids.push({ index, eventUuid });
    seenEventUuids.add(eventUuid);
  });
  if (duplicateEventUuids.length) {
    const first = duplicateEventUuids[0];
    addError('event-uuid-duplicate', `轨迹事件 uuid 重复，共 ${duplicateEventUuids.length} 处；首处 index=${first.index} uuid=${first.eventUuid}`);
  }
  if (brokenParentLinks.length) {
    const first = brokenParentLinks[0];
    addError('parent-chain', `轨迹事件 parentUuid 未指向此前事件，共 ${brokenParentLinks.length} 处；首处 index=${first.index} parent=${first.parentUuid}`);
  }
  if (externalRootParentLinks.length) {
    const first = externalRootParentLinks[0];
    warnings.push(issue('warning', 'external-root-parent', `轨迹从 Claude 会话的外部父节点继续，已作为原生根边界保留；index=${first.index} parent=${first.parentUuid}`));
  }

  const sessionIds = [...new Set(events.map(eventSessionId).filter(Boolean).map((value) => String(value).toLowerCase()))];
  if (sessionIds.length !== 1 || !SESSION_ID_PATTERN.test(sessionIds[0] || '')) {
    addError('session', `必须且只能包含一个合法 session ID，实际为 ${sessionIds.length ? sessionIds.join(', ') : '空'}`);
  }
  if (filenameMatch && sessionIds.length === 1 && filenameMatch[1].toLowerCase() !== sessionIds[0]) {
    addError('session-filename', `文件名 session ID 与正文不一致：${filenameMatch[1]} != ${sessionIds[0]}`);
  }

  const initEvents = events.filter((event) => event?.type === 'system' && event?.subtype === 'init');
  const resultEvents = events.filter((event) => event?.type === 'result');
  const streamFormat = initEvents.length > 0 || resultEvents.length > 0;
  const userEvents = events.filter((event) => event?.type === 'user');
  const assistantEvents = events.filter((event) => event?.type === 'assistant');
  const lastConversationEvent = events.findLast((event) => event?.type === 'user' || event?.type === 'assistant');
  const finalAssistantHasText = lastConversationEvent?.type === 'assistant'
    && contentBlocks(lastConversationEvent).some((block) => block?.type === 'text' && String(block.text || '').trim());

  if (!assistantEvents.length) addError('assistant', 'trajectory 缺少 assistant 会话记录');
  if (!finalAssistantHasText) addError('final-assistant', 'trajectory 没有以完整的 assistant 文本答复结束');

  if (streamFormat) {
    if (initEvents.length !== 1) addError('init-count', `system/init 必须恰好 1 个，实际 ${initEvents.length} 个`);
    if (resultEvents.length !== 1) addError('result-count', `result 必须恰好 1 个，实际 ${resultEvents.length} 个`);
    if (resultEvents.length === 1 && (resultEvents[0].subtype !== 'success' || resultEvents[0].is_error !== false)) {
      addError('result-status', `result 必须成功结束，实际 subtype=${resultEvents[0].subtype} is_error=${resultEvents[0].is_error}`);
    }
  } else {
    const humanInputs = userEvents.filter((event) => !isClaudeInternalUserEvent(event)).map(humanUserText).filter(Boolean);
    const lastPrompts = events.filter((event) => event?.type === 'last-prompt');
    if (!userEvents.length) addError('user', 'Claude 规范化轨迹缺少 user 会话记录');
    if (!humanInputs.length) addError('user-prompt', 'Claude 规范化轨迹缺少可识别的用户题面');
    if (!lastPrompts.length) addError('last-prompt-count', 'Claude 规范化轨迹缺少 last-prompt 闭合记录');
  }

  const { uses, results: toolResults } = extractToolActivity(events);
  const useIdCounts = new Map();
  const resultIdCounts = new Map();
  for (const call of uses) {
    if (!call.id) addError('tool-id', '存在缺少 id 的 tool_use');
    else useIdCounts.set(call.id, (useIdCounts.get(call.id) || 0) + 1);
  }
  for (const result of toolResults) {
    if (!result.tool_use_id) addError('tool-result-id', '存在缺少 tool_use_id 的 tool_result');
    else resultIdCounts.set(result.tool_use_id, (resultIdCounts.get(result.tool_use_id) || 0) + 1);
  }
  const duplicateUseIds = [...useIdCounts].filter(([, count]) => count !== 1);
  const duplicateResultIds = [...resultIdCounts].filter(([, count]) => count !== 1);
  const unmatchedUses = [...useIdCounts].filter(([id]) => resultIdCounts.get(id) !== 1);
  const orphanResults = [...resultIdCounts].filter(([id]) => !useIdCounts.has(id));
  if (duplicateUseIds.length) addError('tool-id-duplicate', `存在 ${duplicateUseIds.length} 个重复 tool_use id`);
  if (duplicateResultIds.length) addError('tool-result-id-duplicate', `存在 ${duplicateResultIds.length} 个重复 tool_result id`);
  if (unmatchedUses.length || orphanResults.length) {
    addError('tool-balance', `工具调用/返回未按 ID 一一配对：调用 ${uses.length}，返回 ${toolResults.length}，未配对调用 ${unmatchedUses.length}，孤立返回 ${orphanResults.length}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      eventCount: events.length,
      sessionId: sessionIds.length === 1 ? sessionIds[0] : '',
      taskName: options.taskName || '',
      toolUses: uses.length,
      toolResults: toolResults.length,
      parentLinks: events.filter((event) => event?.parentUuid || event?.parent_uuid).length,
      brokenParentLinks: brokenParentLinks.length,
      externalRootParentLinks: externalRootParentLinks.length,
      format: streamFormat ? 'claude-stream-jsonl' : 'v4-normalized-jsonl',
    },
  };
}

export function validateTrajectoryEvents(events, options = {}) {
  const filename = path.basename(options.filename || '');
  const filenameMatch = filename.match(TRAJECTORY_FILENAME_PATTERN);
  const errors = [];
  const warnings = [];
  const addError = (...args) => errors.push(issue('error', ...args));
  const addWarning = (...args) => warnings.push(issue('warning', ...args));
  const executionPolicyVersion = Number(options.executionPolicyVersion || 3);
  const strictExecutionPolicy = executionPolicyVersion !== 2;
  const policyV4 = executionPolicyVersion >= 4;

  if (!Array.isArray(events)) {
    addError('json-shape', 'trajectory 正文必须能解析为事件数组');
    return { ok: false, errors, warnings, stats: { eventCount: 0 } };
  }
  if (!events.length) addError('empty', 'trajectory 事件数组不能为空');
  if (!filenameMatch) addError('filename', '文件名必须为 trajectory_<session-id>.json 或 trajectory_<session-id>.jsonl');

  const invalidEventIndex = events.findIndex((event) => !event || typeof event !== 'object' || Array.isArray(event));
  if (invalidEventIndex >= 0) addError('event-shape', `第 ${invalidEventIndex + 1} 个事件不是 JSON 对象`);

  const sessionIds = [...new Set(events.map(eventSessionId).filter(Boolean).map((value) => String(value).toLowerCase()))];
  if (sessionIds.length !== 1 || !SESSION_ID_PATTERN.test(sessionIds[0] || '')) {
    addError('session', `必须且只能包含一个合法 session ID，实际为 ${sessionIds.length ? sessionIds.join(', ') : '空'}`);
  }
  if (filenameMatch && sessionIds.length === 1 && filenameMatch[1].toLowerCase() !== sessionIds[0]) {
    addError('session-filename', `文件名 session ID 与正文不一致：${filenameMatch[1]} != ${sessionIds[0]}`);
  }

  const initEvents = events.filter((event) => event?.type === 'system' && event?.subtype === 'init');
  const results = events.filter((event) => event?.type === 'result');
  const retries = events.filter((event) => event?.type === 'system' && event?.subtype === 'api_retry');
  const nativeTranscript = initEvents.length === 0 && results.length === 0 && events.some((event) => event?.sessionId);
  if (nativeTranscript) {
    const userEvents = events.filter((event) => event?.type === 'user');
    const assistantEvents = events.filter((event) => event?.type === 'assistant');
    const humanInputs = userEvents.filter((event) => !isClaudeInternalUserEvent(event)).map(humanUserText).filter(Boolean);
    const lastPrompts = events.filter((event) => event?.type === 'last-prompt');
    const lastConversationEvent = events.findLast((event) => event?.type === 'user' || event?.type === 'assistant');
    const finalAssistantHasText = contentBlocks(lastConversationEvent).some((block) => block?.type === 'text' && String(block.text || '').trim());
    if (!userEvents.length) addError('native-user', 'Claude 原生轨迹缺少 user 会话记录');
    if (!assistantEvents.length) addError('native-assistant', 'Claude 原生轨迹缺少 assistant 会话记录');
    if (!events.some((event) => event?.type === 'last-prompt')) addError('native-last-prompt', 'Claude 原生轨迹缺少 last-prompt 闭合记录');
    if (lastConversationEvent?.type !== 'assistant' || !finalAssistantHasText) addError('native-final', 'Claude 原生轨迹没有以完整的 assistant 文本答复结束');
    if (policyV4) {
      if (humanInputs.length !== 1) addError('single-user-turn', `V4 轨迹必须只有一轮完整用户输入，实际 ${humanInputs.length} 轮`);
      if (lastPrompts.length !== 1) addError('last-prompt-count', `V4 轨迹必须只有一个 last-prompt，实际 ${lastPrompts.length} 个`);
      if (humanInputs.length === 1 && lastPrompts.length === 1 && String(lastPrompts[0].lastPrompt || '').trim() !== humanInputs[0]) {
        addError('last-prompt-content', 'V4 last-prompt 必须与完整用户题面逐字一致，不能截断');
      }
    }
  } else {
    if (initEvents.length !== 1) addError('init-count', `system/init 必须恰好 1 个，实际 ${initEvents.length} 个`);
    if (results.length !== 1) addError('result-count', `result 必须恰好 1 个，实际 ${results.length} 个`);
    if (results.length === 1 && (results[0].subtype !== 'success' || results[0].is_error !== false)) {
      addError('result-status', `result 必须成功结束，实际 subtype=${results[0].subtype} is_error=${results[0].is_error}`);
    }
  }
  if (retries.length) addWarning('api-retry', `存在 ${retries.length} 个 api_retry 事件，但最终会话仍完整闭合`);

  const permissionDenials = results.flatMap((result) => Array.isArray(result.permission_denials) ? result.permission_denials : []);
  if (permissionDenials.length) addWarning('permission-denial-recovered', `会话记录了 ${permissionDenials.length} 次权限拒绝，但最终结果完整成功；仅保留为复核提示`);
  const interrupted = events.filter((event) => event?.tool_use_result?.interrupted === true || event?.toolUseResult?.interrupted === true || event?.subtype === 'aborted_streaming');
  if (interrupted.length) addError('interrupted', `存在 ${interrupted.length} 个中断事件或工具返回`);

  const init = initEvents[0] || {};
  const workspaceRoot = options.workspaceRoot || init.cwd || events.map(eventCwd).find(Boolean) || '';
  const taskRoot = workspaceRoot && path.basename(workspaceRoot) === 'workspace' ? path.dirname(workspaceRoot) : '';
  const taskType = options.taskType || '';
  const { uses, results: toolResults } = extractToolActivity(events);
  const useIdCounts = new Map();
  const resultIdCounts = new Map();
  for (const call of uses) if (call.id) useIdCounts.set(call.id, (useIdCounts.get(call.id) || 0) + 1);
  for (const result of toolResults) if (result.tool_use_id) resultIdCounts.set(result.tool_use_id, (resultIdCounts.get(result.tool_use_id) || 0) + 1);
  const duplicateUseIds = [...useIdCounts].filter(([, count]) => count !== 1);
  const unmatchedUses = [...useIdCounts].filter(([id]) => resultIdCounts.get(id) !== 1);
  const orphanResults = [...resultIdCounts].filter(([id]) => !useIdCounts.has(id));
  if (uses.some((call) => !call.id)) addError('tool-id', '存在缺少 id 的 tool_use');
  if (duplicateUseIds.length) addError('tool-id-duplicate', `存在 ${duplicateUseIds.length} 个重复 tool_use id`);
  if (unmatchedUses.length || orphanResults.length) {
    addError('tool-balance', `工具调用/返回未按 ID 一一配对：调用 ${uses.length}，返回 ${toolResults.length}，未配对调用 ${unmatchedUses.length}，孤立返回 ${orphanResults.length}`);
  }

  if (policyV4 && ['bugfix', 'diagnosis'].includes(taskType)) {
    const inspections = uses.map((call) => ({ call, ...sourceInspectionKind(call.name, call.input) }));
    const firstTest = inspections.find((item) => item.kind === 'test');
    const firstImplementation = inspections.find((item) => item.kind === 'implementation');
    if (taskType === 'diagnosis' && firstTest) {
      addError(
        'diagnosis-test-source-inspection',
        `Diagnosis 工具 #${firstTest.call.ordinal} 检查了测试源码；诊断必须仅依据生产调用链和公开运行结果，测试不得参与定位或确认答案`,
        firstTest.evidence,
      );
    } else if (firstTest && (!firstImplementation || firstTest.call.ordinal < firstImplementation.call.ordinal)) {
      addError(
        'test-source-before-implementation',
        `工具 #${firstTest.call.ordinal} 在读取直接调用链的生产实现前检查了测试源码；测试不得替模型完成定位`,
        firstTest.evidence,
      );
    }
  }

  const failedToolResults = toolResults.filter((result) => result.is_error === true);
  if (failedToolResults.length) addWarning('tool-errors', `存在 ${failedToolResults.length} 个失败的工具调用，需要确认是否属于预期失败测试`);

  const protectedAccesses = [];
  const mutations = [];
  for (const call of uses) {
    const protectedEvidence = hasProtectedRead(call, workspaceRoot);
    if (protectedEvidence) protectedAccesses.push({ call, evidence: protectedEvidence });

    if (DIRECT_WRITE_TOOLS.has(call.name)) {
      if (call.name === 'apply_patch' || call.name === 'ApplyPatch') {
        mutations.push(...patchTargets(call, workspaceRoot, call.ordinal));
      } else {
        const target = resolveMutationTarget(directTarget(call), workspaceRoot);
        if (target) mutations.push({ target, kind: call.name, toolOrdinal: call.ordinal, evidence: `${call.name} ${target}` });
      }
    } else if (call.name === 'Bash') {
      mutations.push(...bashMutations(String(call.input?.command || ''), workspaceRoot, call.ordinal));
    }
  }
  for (const access of protectedAccesses) {
    addError('protected-access', `工具 #${access.call.ordinal} ${access.call.name} 读取了 gold 标准答案或 grader 隐藏验收`, access.evidence);
  }

  const protectedMutations = mutations.filter((mutation) => PROTECTED_PATH_PATTERN.test(mutation.target) || (taskRoot && isInside(path.join(taskRoot, 'pristine'), mutation.target)));
  for (const mutation of protectedMutations) {
    addError('protected-mutation', `工具 #${mutation.toolOrdinal} 修改了受保护的 gold/grader/pristine 内容`, mutation.target);
  }

  const workspaceMutations = mutations.filter((mutation) => isInside(workspaceRoot, mutation.target));
  const auditedToolNames = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'apply_patch', 'ApplyPatch']);
  const audit = policyV4
    ? analyzeMutationAudit(options.auditRecords, {
      expectedToolUses: uses.filter((call) => auditedToolNames.has(call.name)),
      deniedToolUseIds: permissionDeniedToolUseIds(events),
    })
    : { ok: true, errors: [], warnings: [], mutations: [] };
  for (const message of audit.errors) addError('mutation-audit', message);
  for (const message of audit.warnings) addWarning('mutation-audit', message);
  const auditWorkspaceMutations = audit.mutations.filter((mutation) => mutation.filename.startsWith('workspace/'));
  const auditTempSourceMutations = audit.mutations.filter((mutation) => mutation.filename.startsWith('temp-source/'));
  const auditOrdinalById = new Map(uses.map((call) => [call.id, call.ordinal]));
  const effectiveWorkspaceMutations = policyV4
    ? auditWorkspaceMutations.map((mutation) => ({
      target: path.join(workspaceRoot || '/workspace', mutation.filename.slice('workspace/'.length)),
      kind: mutation.toolName || 'audit',
      toolOrdinal: auditOrdinalById.get(mutation.toolUseId) || Number.MAX_SAFE_INTEGER,
      evidence: mutation.filename,
    }))
    : workspaceMutations;
  if (taskType === 'diagnosis' && policyV4) {
    const readOnly = validateDiagnosisReadOnlyEvents(events, { workspaceRoot });
    for (const readOnlyIssue of readOnly.errors.filter((item) => item.code === 'diagnosis-write-command')) {
      errors.push(readOnlyIssue);
    }
  }
  if (taskType === 'diagnosis' && workspaceMutations.length) {
    addError('diagnosis-mutation', `diagnosis 轨迹修改了工作区 ${workspaceMutations.length} 次，诊断任务必须保持 workspace 不变`, workspaceMutations.slice(0, 4).map((item) => `#${item.toolOrdinal} ${item.kind} ${item.target}`).join('; '));
  }
  if (taskType === 'diagnosis' && policyV4 && (auditWorkspaceMutations.length || auditTempSourceMutations.length)) {
    addError('diagnosis-global-code-write', `diagnosis 轨迹检测到 ${auditWorkspaceMutations.length} 次工作区写入和 ${auditTempSourceMutations.length} 次临时源码写入，必须全程零代码写入`, [...auditWorkspaceMutations, ...auditTempSourceMutations].slice(0, 6).map((item) => `${item.toolUseId} ${item.filename}`).join('; '));
  }
  if (taskType === 'bugfix' && !effectiveWorkspaceMutations.length) {
    addError('bugfix-no-patch', 'bugfix 轨迹未发现工作区补丁操作');
  }

  const mutationGroups = new Map();
  for (const mutation of effectiveWorkspaceMutations) {
    if (!mutationGroups.has(mutation.target)) mutationGroups.set(mutation.target, []);
    mutationGroups.get(mutation.target).push(mutation);
  }
  const maxWrites = Number.isInteger(options.maxWrites) ? options.maxWrites : 2;
  for (const [target, items] of mutationGroups) {
    if (items.length > maxWrites) {
      const args = ['repeated-mutation', `同一工作区文件被写入/删除 ${items.length} 次，需要复核是否属于有依据的连续修改`, `${target}: ${items.map((item) => `#${item.toolOrdinal} ${item.kind}`).join(', ')}`];
      addWarning(...args);
    }
  }

  const rollbackCalls = [];
  for (const call of uses.filter((item) => item.name === 'Bash')) {
    const command = String(call.input?.command || '');
    if (!ROLLBACK_PATTERN.test(command)) continue;
    const related = bashMutations(command, workspaceRoot, call.ordinal).filter((mutation) => isInside(workspaceRoot, mutation.target));
    if (related.length) rollbackCalls.push({ call, command });
  }
  if (rollbackCalls.length === 1) {
    addWarning('single-rollback', `工具 #${rollbackCalls[0].call.ordinal} 执行了一次工作区还原，需要结合上下文确认是否为有依据的清理`, rollbackCalls[0].command.slice(0, 260));
  } else if (rollbackCalls.length > 1) {
    addWarning('repeated-rollback-semantic-review', `轨迹执行了 ${rollbackCalls.length} 次工作区回退或还原，交由只读语义质检判断是否属于无依据试错、恢复旧故障或反复修改同一位置`, rollbackCalls.slice(0, 4).map(({ call, command }) => `#${call.ordinal} ${command.slice(0, 120)}`).join('; '));
  }

  const bashCommands = uses.filter((call) => call.name === 'Bash').map((call) => ({ ordinal: call.ordinal, command: String(call.input?.command || '') }));
  const allCommands = bashCommands.map((item) => item.command).join('\n');
  for (const item of bashCommands) {
    if (strictExecutionPolicy && REQUIRED_VALIDATION_PATTERN.test(item.command) && commandMasksExit(item.command)) {
      addWarning('masked-exploratory-exit', `工具 #${item.ordinal} 的命令没有保留可靠退出码，不能作为最终验收证据`, item.command.slice(0, 320));
    }
  }
  if (taskType === 'bugfix') {
    if (!TARGET_TEST_PATTERN.test(allCommands)) addError('target-test', 'bugfix 轨迹缺少目标测试命令（run_target.sh 或 go test -run）');
    if (!bashCommands.some((item) => isFullTestCommand(item.command))) addError('full-test', 'bugfix 轨迹缺少独立全量测试命令（run_full.sh 或不带 -run 的 go test ./...）');
  }
  if (taskType === 'diagnosis' && strictExecutionPolicy && !DIAGNOSIS_REPRO_PATTERN.test(allCommands)) {
    addError('diagnosis-reproduction', 'diagnosis 轨迹缺少基于现有代码或公开接口的可重复复现证据（go test -run、本地 HTTP 或项目自带复现脚本）');
  }

  const calls = verificationCalls(uses, toolResults);
  let verification = {};
  if (policyV4 && taskType === 'bugfix') {
    const fixMutations = effectiveWorkspaceMutations.filter((mutation) => !TEST_FILE_PATTERN.test(mutation.target));
    const firstFixMutation = Math.min(...fixMutations.map((mutation) => mutation.toolOrdinal));
    const lastFixMutation = Math.max(...fixMutations.map((mutation) => mutation.toolOrdinal));
    if (!fixMutations.length) addError('bugfix-no-effective-fix', 'bugfix 必须产生与题目范围相称的非测试补丁，不能只修改测试');
    const focused = calls.filter((call) => TARGET_TEST_PATTERN.test(call.command));
    const red = focused.find((call) => call.ordinal < firstFixMutation && call.outcome === 'failure' && !commandMasksExit(call.command));
    const green = focused.find((call) => call.ordinal > lastFixMutation && call.outcome === 'success' && !commandMasksExit(call.command));
    const full = calls.find((call) => call.ordinal > lastFixMutation && isFullTestCommand(call.command) && call.outcome === 'success' && !commandMasksExit(call.command));
    const staticCheck = calls.find((call) => call.ordinal > lastFixMutation && STATIC_CHECK_PATTERN.test(call.command) && call.outcome === 'success' && !commandMasksExit(call.command));
    const readBeforeFix = uses.some((call) => call.ordinal < firstFixMutation && relevantImplementationRead(call, options.goldFiles));
    if (!readBeforeFix) addError('locate-before-fix', 'bugfix 在修改实现或配置前必须读取并定位相关内容');
    if (!red) addError('red-before-fix', 'bugfix 缺少生产代码修改前真实失败且退出码未被掩盖的目标复现');
    if (!green) addError('green-after-fix', 'bugfix 缺少生产代码修改后真实成功的目标测试');
    if (!full) addError('full-after-fix', 'bugfix 缺少最终补丁完成后的全量测试成功结果');
    verification = {
      readBeforeFix,
      firstSourceMutation: Number.isFinite(firstFixMutation) ? firstFixMutation : null,
      lastFixMutation: Number.isFinite(lastFixMutation) ? lastFixMutation : null,
      redOrdinal: red?.ordinal || null,
      greenOrdinal: green?.ordinal || null,
      fullOrdinal: full?.ordinal || null,
      staticOrdinal: staticCheck?.ordinal || null,
      focusedCommand: green?.command || red?.command || '',
    };
  }
  if (policyV4 && taskType === 'diagnosis') {
    const expectedFiles = [...new Set((options.goldFiles || []).map(String).filter(Boolean))];
    const expectedSymbols = [...new Set((options.goldSymbols || []).map(String).filter(Boolean))];
    const mechanismKeywords = [...new Set((options.mechanismKeywords || []).map(String).filter((value) => value.length >= 2))];
    const answer = finalAssistantText(events);
    const reproduction = calls.find((call) => DIAGNOSIS_REPRO_PATTERN.test(call.command) && call.outcome !== 'missing' && !commandMasksExit(call.command));
    if (!reproduction) addError('diagnosis-reproduction-result', 'diagnosis 缺少带完整工具返回且退出码未被掩盖的公开复现命令');
    if (!expectedFiles.length || !expectedSymbols.length || mechanismKeywords.length < 2) {
      addError('diagnosis-gold-context', 'diagnosis V4 校验缺少 Gold 文件、符号或机制关键词上下文');
    } else {
      const evidence = diagnosisRootCauseEvidence(answer, expectedFiles, expectedSymbols, mechanismKeywords);
      if (evidence.missingFiles.length === expectedFiles.length) addError('diagnosis-file-recall', `诊断结论未命中 Gold 文件：${expectedFiles.map((value) => path.basename(value)).join('、')}`);
      if (evidence.missingSymbols.length === expectedSymbols.length) addError('diagnosis-symbol-recall', `诊断结论未命中 Gold 符号：${expectedSymbols.join('、')}`);
      if (evidence.matchedKeywords.length < 2) addWarning('diagnosis-mechanism-semantic-review', `诊断结论未逐字命中两个 Gold 机制关键词，交由只读语义质检判断同义表达：${mechanismKeywords.join('、')}`);
      const readGoldLocation = uses.some((call) => relevantCodeRead(call, expectedFiles));
      if (!readGoldLocation) addError('diagnosis-code-evidence', `轨迹没有实际读取 Gold 根因涉及的代码文件：${expectedFiles.map((value) => path.basename(value)).join('、')}`);
      verification = { expectedFiles, expectedSymbols, mechanismKeywords, matchedMechanismKeywords: evidence.matchedKeywords, readGoldLocation, reproductionCommand: reproduction?.command || '' };
    }
  }

  const modelNames = [...new Set(events.filter((event) => event?.type === 'assistant').map((event) => event?.message?.model).filter(Boolean))];
  if (!nativeTranscript && !init.model) addWarning('model-missing', 'system/init 未记录模型名称');
  if (modelNames.length > 1 || (init.model && modelNames.length === 1 && modelNames[0] !== init.model)) {
    addError('model-inconsistent', `轨迹内模型名称不一致：init=${init.model || '空'} assistant=${modelNames.join(', ') || '空'}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      eventCount: events.length,
      sessionId: sessionIds.length === 1 ? sessionIds[0] : '',
      taskType,
      taskName: options.taskName || (taskRoot ? path.basename(taskRoot) : ''),
      toolUses: uses.length,
      toolResults: toolResults.length,
      workspaceMutations: workspaceMutations.length,
      distinctWorkspaceFiles: mutationGroups.size,
      apiRetries: retries.length,
      permissionDenials: permissionDenials.length,
      failedToolResults: failedToolResults.length,
      model: init.model || modelNames[0] || '',
      format: nativeTranscript ? 'claude-native-jsonl' : 'stream-json-array',
      executionPolicyVersion,
      verification,
      auditMutations: audit.mutations.length,
    },
  };
}

export function parseTrajectoryJson(text) {
  const value = String(text || '').replace(/^\uFEFF/u, '');
  try {
    return JSON.parse(value);
  } catch (arrayError) {
    const lines = value.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) throw arrayError;
    return lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (lineError) {
        throw new Error(`JSONL 第 ${index + 1} 行解析失败：${lineError.message}`);
      }
    });
  }
}
