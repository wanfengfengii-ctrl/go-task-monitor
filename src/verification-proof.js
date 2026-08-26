import crypto from 'node:crypto';
import { parseTrajectoryJson, validateTrajectoryIntegrityEvents } from './trajectory-file-validator.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const DIRECT_GO_TEST_PATTERN = /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+)\s+)*go\s+test\b/i;
const DIRECT_GO_RUN_PATTERN = /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+)\s+)*go\s+run\b/i;
const WRAPPER_SCRIPT_PATTERN = /(?:^|[\s/])verify_cmds\.sh\b|run_(?:target|full|static|docker)\.sh\b|run_docker\.sh\b/i;
const EXTERNAL_NETWORK_PATTERN = /https?:\/\/(?!localhost(?::\d+)?(?:[\s/'"?]|$)|127\.0\.0\.1(?::\d+)?(?:[\s/'"?]|$))[^\s'"\\]+/i;
const WRITE_OR_DANGEROUS_COMMAND_PATTERN = /(?:^|[\s;&|])(?:rm|mv|cp|install|tee|truncate|touch|mkdir|python\d*|perl|ruby|node)\b|(?:^|\s)(?:sed|perl)\s+-i\b/i;
const NATURAL_LANGUAGE_HTTP_COMMAND_PATTERN = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i;
// Diagnosis records from the old exporter sometimes prefixed an English or
// Chinese scenario description to an otherwise non-executable HTTP example.
// Treat those as prose, not as a public command; letting them reach the proof
// runner only turns an export error into a long, misleading timeout.
const DIAGNOSIS_PROSE_COMMAND_PREFIX_PATTERN = /^(?:HTTP(?:\s+(?:场景|scenario))?|HTTPS(?:\s+(?:场景|scenario))?|httptest(?:\s+(?:场景|scenario))?|(?:API|接口|请求|调用|场景|测试场景))\s*[:：]/i;
const DIAGNOSIS_PROSE_LEADING_WORD_PATTERN = /^(?:with|when|while|after|before|then|once|inject|create|submit|call|start|use|let|make|given|configure|open|advance|perform|send)\b/i;
export const CONCURRENCY_VERIFY_MIN_COUNT = 20;

export function isConcurrencyVerificationRecord(record = {}) {
  const category = String(record?.bug_category || record?.bugCategory || '').trim();
  return record?.concurrency === true
    || /^(?:concurrency(?:并发问题)?|并发(?:问题|错误|缺陷)?)$/i.test(category)
    || (Array.isArray(record?.runtime_mechanisms) && record.runtime_mechanisms.includes('concurrency_race'));
}

function hasShellComposition(command, { allowPwdSubstitution = false } = {}) {
  let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '"') {
        quote = '';
        continue;
      }
      if (char === '`') return true;
      if (char === '$' && command[index + 1] === '(') {
        if (allowPwdSubstitution && command.slice(index, index + 6) === '$(pwd)') {
          index += 5;
          continue;
        }
        return true;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if ('\r\n;&|<>`'.includes(char)) return true;
    if (char === '$' && command[index + 1] === '(') {
      if (allowPwdSubstitution && command.slice(index, index + 6) === '$(pwd)') {
        index += 5;
        continue;
      }
      return true;
    }
  }
  return Boolean(quote);
}

function goTestDetails(command) {
  if (!DIRECT_GO_TEST_PATTERN.test(command)) return null;
  const runMatch = command.match(/(?:^|\s)-run(?:=|\s+)(?:['"]?)([^\s'"]+)(?:['"]?)(?:\s|$)/);
  const countMatch = command.match(/(?:^|\s)-count(?:=|\s+)(\d+)(?:\s|$)/);
  return {
    hasPackage: /(?:^|\s)(?:\.|\.\/[A-Za-z0-9_.\/-]+)(?:\s|$)/.test(command),
    hasRun: Boolean(runMatch),
    runExpression: runMatch?.[1] || '',
    repeatCount: countMatch ? Number(countMatch[1]) : 0,
    hasRace: /(?:^|\s)-race(?:\s|$)/.test(command),
    broad: /(?:^|\s)\.\/\.\.\.(?:\s|$)/.test(command),
  };
}

function focusedGoTestName(command) {
  const details = goTestDetails(String(command || ''));
  if (!details?.hasRun) return '';
  const names = [...new Set(details.runExpression.match(/\bTest[A-Za-z0-9_]+\b/g) || [])];
  return names.length === 1 ? names[0] : '';
}

export function goTargetTestRedIssues(command, output = '') {
  const details = goTestDetails(String(command || ''));
  if (!details?.hasRun) return [];
  const value = String(output || '');
  const issues = [];
  const testName = focusedGoTestName(command);
  const escapedName = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const runPattern = testName
    ? new RegExp(`(?:^|\\n)=== RUN\\s+${escapedName}(?:\\/|\\s|$)`, 'm')
    : /(?:^|\n)=== RUN\s+Test[A-Za-z0-9_]+(?:\/|\s|$)/m;
  const failPattern = testName
    ? new RegExp(`(?:^|\\n)--- FAIL:\\s+${escapedName}(?:\\/|\\s|\\()`, 'm')
    : /(?:^|\n)--- FAIL:\s+Test[A-Za-z0-9_]+(?:\/|\s|\()/m;
  if (/\[(?:build failed|setup failed)\]/i.test(value) || /(?:^|\n)FAIL\s+\S+\s+\[setup failed\]/im.test(value)) {
    issues.push('目标测试在进入断言前发生构建或初始化失败');
  }
  if (!runPattern.test(value)) {
    issues.push(testName ? `没有执行到目标测试 ${testName}` : '没有执行到 -run 指定的目标测试');
  }
  if (!failPattern.test(value)) {
    issues.push(testName ? `目标测试 ${testName} 没有形成断言失败` : '目标测试没有形成断言失败');
  }
  return [...new Set(issues)];
}

function isLocalHttpCommand(command) {
  return /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+)\s+)*curl\b/i.test(command)
    && /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/'"?\s]|$)/i.test(command);
}

function isDirectProjectCli(command) {
  const stripped = String(command).replace(/^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+)\s+)*/, '');
  const executable = stripped.match(/^([^\s]+)/)?.[1] || '';
  if (!executable || /^(?:go|docker|bash|sh|zsh|git|gh|curl|rm|mv|cp|tee|sed|awk|grep|rg|cat|head|tail)$/i.test(executable)) return false;
  return /^(?:\.\/?[A-Za-z0-9_.\/-]+|[A-Za-z0-9_.-]+)$/.test(executable);
}

function dockerShellBodyHasComposition(command) {
  if (!/\b(?:bash|sh)\s+-c\s+['"]/i.test(command)) return false;
  return /(?:;|&&|\|\||>>?|<<)/.test(command.match(/\b(?:bash|sh)\s+-c\s+(.+)$/i)?.[1] || '')
    || /\s\|\s/.test(command.match(/\b(?:bash|sh)\s+-c\s+(.+)$/i)?.[1] || '');
}

function sha256(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

export function verificationCommandsSha256(verifyCmds = []) {
  return sha256(`${JSON.stringify(verifyCmds)}\n`);
}

export function directPublicVerifyCommandIssues(verifyCmds = [], taskType = '', {
  concurrency = false,
  concurrencyMinCount = CONCURRENCY_VERIFY_MIN_COUNT,
} = {}) {
  const commands = Array.isArray(verifyCmds) ? verifyCmds.map((command) => String(command).trim()) : [];
  const issues = [];
  if (!commands.length || commands.some((command) => !command)) {
    issues.push('verify_cmds 必须是包含至少一条真实公开验证命令的非空数组');
    return issues;
  }
  let targetCount = 0;
  let concurrencyTargetCount = 0;
  commands.forEach((command, index) => {
    const label = commands.length > 1 ? `第 ${index + 1} 条命令` : 'verify_cmds';
    const isDocker = /^docker\s+/i.test(command);
    const isDockerBuild = /^docker\s+build\b/i.test(command);
    const isDockerRun = /^docker\s+run\b/i.test(command);
    const isDockerCleanup = /^docker\s+image\s+rm\b/i.test(command);
    const goTest = goTestDetails(command);

    if (/\r|\n/.test(command)) issues.push(`${label} 必须是一条可独立执行的单行命令`);
    if (taskType === 'diagnosis' && /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+)\s+)*MODEL_REPRO=/i.test(command)) {
      issues.push(`${label} 不能包含内部 MODEL_REPRO 环境前缀；请直接执行 go test 或真实公开命令`);
    }
    if (taskType === 'diagnosis' && NATURAL_LANGUAGE_HTTP_COMMAND_PATTERN.test(command)) {
      issues.push(`${label} 不能把 HTTP/API 操作说明当作命令；请提供可直接执行的 go test、go run 或本地 curl 命令`);
    }
    if (taskType === 'diagnosis' && DIAGNOSIS_PROSE_COMMAND_PREFIX_PATTERN.test(command)) {
      issues.push(`${label} 不能把场景说明当作命令；请提供可直接执行的 go test、go run 或本地 curl 命令`);
    }
    if (taskType === 'diagnosis' && DIAGNOSIS_PROSE_LEADING_WORD_PATTERN.test(command)) {
      issues.push(`${label} 不能把英文操作步骤当作命令；请提供可直接执行的 go test、go run 或本地 curl 命令`);
    }
    if (/\bundefined\b/i.test(command)) issues.push(`${label} 不能包含完整单词 undefined`);
    if (WRAPPER_SCRIPT_PATTERN.test(command)) issues.push(`${label} 不能通过 verify_cmds.sh、run_target.sh 等包装脚本间接执行`);
    if (EXTERNAL_NETWORK_PATTERN.test(command)) issues.push(`${label} 不能依赖外部网络地址`);
    if (/\/(?:private\/)?tmp\/|\/var\/folders\//i.test(command)) issues.push(`${label} 不能依赖本机临时路径`);
    if (hasShellComposition(command, { allowPwdSubstitution: isDocker })) {
      issues.push(`${label} 不能使用顶层管道、重定向、heredoc、后续命令或除 $(pwd) 外的命令替换`);
    }

    if (goTest) {
      if (!goTest.hasPackage) issues.push(`${label} 必须明确写出目标 Go 包`);
      if (!Number.isInteger(goTest.repeatCount) || goTest.repeatCount < 1) issues.push(`${label} 的 go test 必须显式使用正整数 -count=N`);
      if (goTest.hasRun) {
        if (goTest.broad) issues.push(`${label} 的目标测试不能使用 go test ./...，必须明确写出目标包`);
        if (!/\bTest[A-Za-z0-9_]+\b/.test(goTest.runExpression)) issues.push(`${label} 必须通过 -run 明确写出目标 Test 测试名称`);
        if (concurrency) {
          if (!goTest.hasRace) issues.push(`${label} 的并发目标测试必须使用 -race`);
          if (goTest.repeatCount < concurrencyMinCount) {
            issues.push(`${label} 的并发目标测试必须使用 -count=N，且 N 不得小于 ${concurrencyMinCount}`);
          }
          if (goTest.hasRace && goTest.repeatCount >= concurrencyMinCount) concurrencyTargetCount += 1;
        }
        targetCount += 1;
      }
      return;
    }

    if (DIRECT_GO_RUN_PATTERN.test(command)) {
      if (taskType !== 'diagnosis') issues.push(`${label} 的 go run 只允许用于 diagnosis 的真实公开复现`);
      else targetCount += 1;
      return;
    }

    if (isLocalHttpCommand(command)) {
      if (taskType !== 'diagnosis') issues.push(`${label} 的本地 HTTP 调用只允许用于 diagnosis 的真实公开复现`);
      else targetCount += 1;
      return;
    }

    if (isDockerBuild || isDockerCleanup) return;
    if (isDockerRun) {
      if (!/--network(?:=|\s+)none\b/i.test(command)) issues.push(`${label} 的 docker run 必须设置 --network none`);
      if (WRITE_OR_DANGEROUS_COMMAND_PATTERN.test(command)) issues.push(`${label} 的 docker run 包含写文件或危险辅助命令`);
      if (dockerShellBodyHasComposition(command)) issues.push(`${label} 的容器内 Shell 只能执行一条直接命令，不能追加管道、重定向或后续命令`);
      if (/\bgo\s+test\b[^\n]*\.\/\.\.\.[^\n]*\s-run(?:=|\s)|\bgo\s+test\b[^\n]*\s-run(?:=|\s)[^\n]*\.\/\.\.\./i.test(command)) {
        issues.push(`${label} 的目标测试不能使用 go test ./...，必须明确写出目标包`);
      }
      const kind = verificationCommandKind(command, taskType);
      if (kind === 'target') targetCount += 1;
      else if (kind !== 'verification') issues.push(`${label} 不是可识别的 Docker 目标或验证命令`);
      return;
    }

    if (/^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+)\s+)*(?:go\s+vet|staticcheck|gofmt\s+-(?:d|l))\b/i.test(command)) return;
    if (taskType === 'diagnosis' && isDirectProjectCli(command)) {
      if (WRITE_OR_DANGEROUS_COMMAND_PATTERN.test(command)) issues.push(`${label} 不能执行写文件或危险辅助命令`);
      else targetCount += 1;
      return;
    }
    if (isDocker) issues.push(`${label} 不是支持的 docker build、docker run 或 docker image rm 命令`);
    else issues.push(`${label} 不是可直接执行的目标验证命令`);
  });
  if (!targetCount) {
    issues.push('verify_cmds 必须至少包含一条目标 Bug 复现命令；go test ./...、go vet、Docker 构建和清理不能单独作为目标证明');
  }
  if (concurrency && targetCount && !concurrencyTargetCount) {
    issues.push(`并发题 verify_cmds 必须至少包含一条 go test -race -count=N 目标命令，且 N 不得小于 ${concurrencyMinCount}`);
  }
  return [...new Set(issues)];
}

function contentBlocks(event) {
  return Array.isArray(event?.message?.content) ? event.message.content : [];
}

function bashCommands(events) {
  return events.flatMap((event) => contentBlocks(event)
    .filter((block) => event?.type === 'assistant' && block?.type === 'tool_use' && block?.name === 'Bash')
    .map((block) => String(block?.input?.command || '')));
}

function toolResultText(block) {
  if (typeof block?.content === 'string') return block.content;
  if (Array.isArray(block?.content)) return block.content.map((item) => typeof item === 'string' ? item : String(item?.text || '')).join('\n');
  return String(block?.content || '');
}

function toolResultExitCode(block) {
  if (block?.is_error === false) return 0;
  if (block?.is_error !== true) return null;
  const match = toolResultText(block).match(/(?:^|\n)Exit code\s+(\d+)(?:\n|$)/i);
  return match ? Number(match[1]) : null;
}

export function directVerificationExecutions(events) {
  const results = new Map(events.flatMap((event) => contentBlocks(event)
    .filter((block) => event?.type === 'user' && block?.type === 'tool_result')
    .map((block) => [String(block.tool_use_id || ''), block])));
  return events.flatMap((event) => contentBlocks(event)
    .filter((block) => event?.type === 'assistant' && block?.type === 'tool_use' && block?.name === 'Bash')
    .map((block) => {
      const id = String(block.id || '');
      const result = results.get(id);
      return {
        id,
        command: String(block?.input?.command || ''),
        exitCode: result ? toolResultExitCode(result) : null,
        hasResult: Boolean(result),
        isError: result?.is_error === true,
        output: result ? toolResultText(result) : '',
      };
    }));
}

export function platformCompatibleVerificationProofIssues({
  phase = '',
  taskType = '',
  verifyCmds = [],
  trajectoryContent = '',
} = {}) {
  const issues = [];
  let events;
  try {
    events = parseTrajectoryJson(String(trajectoryContent || ''));
  } catch (error) {
    return [`云端验证轨迹无法解析：${error.message}`];
  }
  const commands = Array.isArray(verifyCmds) ? verifyCmds.map((command) => String(command)) : [];
  const executions = directVerificationExecutions(events);
  if (executions.length !== commands.length) {
    issues.push(`云端验证轨迹必须逐条执行 ${commands.length} 条 verify_cmds，实际 ${executions.length} 条`);
  }
  let targetCount = 0;
  executions.forEach((execution, index) => {
    const command = commands[index] || '';
    if (execution.command !== command) {
      issues.push(`云端验证轨迹第 ${index + 1} 条 Bash 命令与 verify_cmds 不一致`);
      return;
    }
    if (!execution.id || !execution.hasResult || !Number.isInteger(execution.exitCode)) {
      issues.push(`云端验证轨迹第 ${index + 1} 条命令缺少可配对的 tool_result 或真实退出码`);
      return;
    }
    if (verificationCommandKind(command, taskType) !== 'target') return;
    targetCount += 1;
    if (phase === 'pre_fix') {
      if (execution.exitCode === 0 || !execution.isError) {
        issues.push(`pre_fix 第 ${index + 1} 条目标命令没有以非零退出码呈红`);
        return;
      }
      if (!/(?:^|\n)Exit code\s+[1-9]\d*(?:\n|$)/i.test(execution.output)) {
        issues.push(`pre_fix 第 ${index + 1} 条目标命令未在 tool_result 中显式记录非零 Exit code`);
      }
      if (DIRECT_GO_TEST_PATTERN.test(command)) {
        issues.push(...goTargetTestRedIssues(command, execution.output)
          .map((issue) => `pre_fix 第 ${index + 1} 条 go test ${issue}`));
      }
    } else if (phase === 'post_fix' && execution.exitCode !== 0) {
      issues.push(`post_fix 第 ${index + 1} 条目标命令未呈绿`);
    }
  });
  if (!targetCount) issues.push('云端验证轨迹中缺少可识别的目标 Bug 命令');
  return [...new Set(issues)];
}

function toolResultOutput(events) {
  return events.flatMap((event) => contentBlocks(event)
    .filter((block) => event?.type === 'user' && block?.type === 'tool_result')
    .map((block) => {
      if (typeof block.content === 'string') return block.content;
      if (Array.isArray(block.content)) return block.content.map((item) => typeof item === 'string' ? item : String(item?.text || '')).join('\n');
      return String(block.content || '');
    }))
    .join('\n');
}

function parseJson(value, label, issues) {
  try {
    return JSON.parse(String(value || ''));
  } catch (error) {
    issues.push(`${label} 不是合法 JSON：${error.message}`);
    return null;
  }
}

function parseJsonLines(value, label, issues) {
  try {
    return String(value || '').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    issues.push(`${label} 不是合法 JSONL：${error.message}`);
    return [];
  }
}

export function verificationCommandKind(command, taskType = '') {
  const value = String(command || '').trim();
  if (/^docker\s+build\b/i.test(value)) return 'infrastructure';
  if (/^docker\s+image\s+rm\b/i.test(value)) return 'cleanup';
  if (/\/grader\/run_target\.sh\b/i.test(value)) return 'target';
  if (/\/grader\/run_(?:full|static)\.sh\b/i.test(value)) return 'verification';
  const goTest = goTestDetails(value);
  if (goTest?.hasRun) return 'target';
  if (goTest || /\bgo\s+vet\b|\bstaticcheck\b|\bgofmt\s+-(?:d|l)\b/i.test(value)) return 'verification';
  if (DIRECT_GO_RUN_PATTERN.test(value) || isLocalHttpCommand(value)) return 'target';
  if (/^docker\s+run\b/i.test(value)) {
    if (/\bgo\s+test\b[^\n]*\s-run(?:=|\s)/i.test(value)
      || (taskType === 'diagnosis' && (/\bgo\s+run\b/i.test(value) || /https?:\/\/(?:localhost|127\.0\.0\.1)/i.test(value)))) return 'target';
    return 'verification';
  }
  if (taskType === 'diagnosis' && isDirectProjectCli(value)) return 'target';
  return 'verification';
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function verificationProofCommand(phase, verifyCmds = []) {
  const args = verifyCmds.map(shellQuote);
  return [`./verify_cmds.sh ${phase}`, ...args].join(' ');
}

export function verificationProofPrompt(phase, verifyCmds = []) {
  return [
    `This is the ${phase} verification session. Use one separate Bash tool call for each command below, in the exact listed order.`,
    'Execute every command verbatim. Shell quoting, $(pwd), or bash -c already present inside a listed Docker command is part of that command and must be preserved. Do not combine commands, add another wrapper, add prefixes or suffixes, retry them, or skip later commands after a failure.',
    'Do not inspect files, read source code, edit anything, or run any command not listed below.',
    'If a Bash result contains a <persisted-output> notice because its output is large, do not read, tail, cat, or otherwise inspect that temporary file. Treat the original Bash tool result and exit status as the complete command result.',
    ...verifyCmds.flatMap((command, index) => [`Command ${index + 1}:`, String(command)]),
    'After all commands have returned, report only whether the verification result was red, green, or an infrastructure error.',
  ].join('\n');
}

function prePersistedOutputVerificationProofPrompt(phase, verifyCmds = []) {
  return verificationProofPrompt(phase, verifyCmds).replace(
    '\nIf a Bash result contains a <persisted-output> notice because its output is large, do not read, tail, cat, or otherwise inspect that temporary file. Treat the original Bash tool result and exit status as the complete command result.',
    '',
  );
}

function legacyDirectVerificationProofPrompt(phase, verifyCmds = []) {
  return [
    `This is the ${phase} verification session. Use one separate Bash tool call for each command below, in the exact listed order.`,
    'Execute every command verbatim. Do not combine commands, wrap them in another command or script, add prefixes or suffixes, retry them, or skip later commands after a failure.',
    'Do not inspect files, read source code, edit anything, or run any command not listed below.',
    ...verifyCmds.flatMap((command, index) => [`Command ${index + 1}:`, String(command)]),
    'After all commands have returned, report only whether the verification result was red, green, or an infrastructure error.',
  ].join('\n');
}

function timedVerificationProofPrompt(phase, verifyCmds = []) {
  return verificationProofPrompt(phase, verifyCmds).replace(
    '\nDo not inspect files',
    '\nSet every Bash tool timeout to 600000 milliseconds so each verification command can finish.\nDo not inspect files',
  );
}

function timedPrePersistedOutputVerificationProofPrompt(phase, verifyCmds = []) {
  return prePersistedOutputVerificationProofPrompt(phase, verifyCmds).replace(
    '\nDo not inspect files',
    '\nSet every Bash tool timeout to 600000 milliseconds so each verification command can finish.\nDo not inspect files',
  );
}

function timedLegacyDirectVerificationProofPrompt(phase, verifyCmds = []) {
  return legacyDirectVerificationProofPrompt(phase, verifyCmds).replace(
    '\nDo not inspect files',
    '\nSet every Bash tool timeout to 600000 milliseconds so each verification command can finish.\nDo not inspect files',
  );
}

function inlineVerificationProofPrompt(phase, verifyCmds = []) {
  const command = verificationProofCommand(phase, verifyCmds);
  return [
    `Use the Bash tool exactly once to run this complete command verbatim: ${command}`,
    'Do not inspect files, read source code, edit anything, run any other command, or retry the command.',
    'After the command returns, report only whether the verification result was red, green, or an infrastructure error.',
  ].join('\n');
}

function timedInlineVerificationProofPrompt(phase, verifyCmds = []) {
  return inlineVerificationProofPrompt(phase, verifyCmds).replace(
    '\nDo not inspect files',
    '\nSet the Bash tool timeout to 600000 milliseconds so the complete dual-architecture verification can finish.\nDo not inspect files',
  );
}

function legacyVerificationProofPrompt(phase) {
  return [
    `Use the Bash tool exactly once to run: ./verify_cmds.sh ${phase}`,
    'Do not inspect files, read source code, edit anything, run any other command, or retry the command.',
    'After the command returns, report only whether the verification result was red, green, or an infrastructure error.',
  ].join('\n');
}

function timedLegacyVerificationProofPrompt(phase) {
  return [
    `Use the Bash tool exactly once to run: ./verify_cmds.sh ${phase}`,
    'Set the Bash tool timeout to 600000 milliseconds so the complete dual-architecture verification can finish.',
    'Do not inspect files, read source code, edit anything, run any other command, or retry the command.',
    'After the command returns, report only whether the verification result was red, green, or an infrastructure error.',
  ].join('\n');
}

export function validateVerificationProofBundle(input = {}) {
  const issues = [];
  const phase = String(input.phase || '');
  const taskType = String(input.taskType || '');
  const expectedResult = phase === 'pre_fix' ? 'red' : phase === 'post_fix' ? 'green' : '';
  if (!expectedResult) issues.push(`不支持的验证证明阶段：${phase || '空'}`);
  const manifest = input.manifest && typeof input.manifest === 'object' ? input.manifest : {};
  const evidence = input.evidence && typeof input.evidence === 'object' ? input.evidence : {};
  const verifyCmds = Array.isArray(input.verifyCmds) ? input.verifyCmds.map(String) : [];
  // A small set of V5 diagnosis deliveries was captured before the public
  // command contract stopped exposing MODEL_REPRO.  Keep validating those
  // proofs against the exact recorded command and hash; only suppress the
  // newer public-command policy error for an explicitly identified historical
  // proof.  This must never affect bugfix proofs or new diagnosis sessions.
  const allowHistoricalDiagnosisModelRepro = Boolean(input.allowHistoricalDiagnosisModelRepro)
    && taskType === 'diagnosis'
    && verifyCmds.length > 0
    && verifyCmds.every((command) => /^MODEL_REPRO=1\s+go\s+test\b/i.test(String(command).trim()));
  const expectedSourceCommit = phase === 'pre_fix' ? String(input.bugBaseCommit || '') : String(input.testModelFixCommit || '');
  const promptContent = String(input.promptContent || '').trim();
  const directPromptVariants = [
    verificationProofPrompt(phase, verifyCmds),
    timedVerificationProofPrompt(phase, verifyCmds),
    prePersistedOutputVerificationProofPrompt(phase, verifyCmds),
    timedPrePersistedOutputVerificationProofPrompt(phase, verifyCmds),
    legacyDirectVerificationProofPrompt(phase, verifyCmds),
    timedLegacyDirectVerificationProofPrompt(phase, verifyCmds),
  ];
  const inlinePromptVariants = [inlineVerificationProofPrompt(phase, verifyCmds), timedInlineVerificationProofPrompt(phase, verifyCmds)];
  const legacyPromptVariants = [legacyVerificationProofPrompt(phase), timedLegacyVerificationProofPrompt(phase)];
  const directCommandMode = manifest.command_mode === 'direct_verify_cmds_v2'
    || (!manifest.command_mode && directPromptVariants.includes(promptContent));
  const inlineCommandMode = manifest.command_mode === 'inline_verify_cmds_v1'
    || (!manifest.command_mode && inlinePromptVariants.includes(promptContent));
  const legacyCommandMode = !directCommandMode && !inlineCommandMode;
  const wrapperCommand = inlineCommandMode ? verificationProofCommand(phase, verifyCmds) : `./verify_cmds.sh ${phase}`;

  if (Number(manifest.policy_version) !== 5) issues.push('证明 manifest 的 policy_version 必须为 5');
  if (manifest.phase !== phase) issues.push(`证明 manifest 阶段必须为 ${phase}`);
  if (manifest.result !== expectedResult) issues.push(`${phase} 证明结果必须为 ${expectedResult}`);
  if (!GIT_SHA_PATTERN.test(expectedSourceCommit)) issues.push(`${phase} 缺少合法的预期源码 commit`);
  if (manifest.source_commit !== expectedSourceCommit) issues.push(`${phase} 证明源码 commit 与任务元数据不一致`);
  if (!verifyCmds.length || verifyCmds.some((command) => !command.trim())) issues.push('verify_cmds 必须是非空命令数组');
  const publicCommandIssues = directPublicVerifyCommandIssues(verifyCmds, taskType);
  issues.push(...(allowHistoricalDiagnosisModelRepro
    ? publicCommandIssues.filter((issue) => !/不能包含内部 MODEL_REPRO 环境前缀/.test(issue))
    : publicCommandIssues));
  const verifyCmdsSha256 = verificationCommandsSha256(verifyCmds);
  if (manifest.verify_cmds_sha256 !== verifyCmdsSha256) issues.push('证明 manifest 未绑定当前 verify_cmds');
  if (manifest.command_mode !== 'direct_verify_cmds_v2') {
    issues.push('V5 验证证明必须逐条、按原文直接执行 verify_cmds，禁止包装脚本或内联包装命令');
  }
  if (directCommandMode && Number(manifest.command_count) !== verifyCmds.length) issues.push('证明 manifest 的 command_count 与 verify_cmds 不一致');
  if (manifest.command_mode && !['direct_verify_cmds_v2', 'inline_verify_cmds_v1'].includes(manifest.command_mode)) {
    issues.push(`证明 manifest 的 command_mode 不受支持：${manifest.command_mode}`);
  }

  for (const field of ['session_id', 'source_commit', 'verify_cmds_sha256', 'trajectory_sha256', 'raw_stream_sha256', 'prompt_sha256', 'result_sha256', 'command_results_sha256']) {
    if (String(evidence[field] || '') !== String(manifest[field] || '')) issues.push(`public.json verification_evidence.${phase}.${field} 与 manifest 不一致`);
  }
  if (evidence.result !== manifest.result) issues.push(`public.json verification_evidence.${phase}.result 与 manifest 不一致`);
  if (directCommandMode) {
    if (evidence.command_mode !== manifest.command_mode) issues.push(`public.json verification_evidence.${phase}.command_mode 与 manifest 不一致`);
    if (Number(evidence.command_count) !== Number(manifest.command_count)) issues.push(`public.json verification_evidence.${phase}.command_count 与 manifest 不一致`);
  }
  if (manifest.session_id && [input.mainSessionId, input.otherSessionId].filter(Boolean).includes(manifest.session_id)) {
    issues.push('主轨迹、pre_fix 和 post_fix 必须使用互不重复的新 Session');
  }

  const artifactContents = {
    trajectory_sha256: input.trajectoryContent,
    raw_stream_sha256: input.rawStreamContent,
    prompt_sha256: input.promptContent,
    result_sha256: input.resultContent,
    command_results_sha256: input.commandResultsContent,
  };
  for (const [field, content] of Object.entries(artifactContents)) {
    if (!SHA256_PATTERN.test(String(manifest[field] || ''))) issues.push(`证明 manifest 缺少合法的 ${field}`);
    else if (manifest[field] !== sha256(content)) issues.push(`证明附件 ${field.replace(/_sha256$/, '')} 的哈希与 manifest 不一致`);
  }
  const expectedPrompts = directCommandMode ? directPromptVariants : inlineCommandMode ? inlinePromptVariants : legacyPromptVariants;
  if (!expectedPrompts.includes(promptContent)) issues.push(`${phase} 证明提示词与系统固定提示不一致`);
  if (manifest.trajectory_filename !== `trajectory_${manifest.session_id}.jsonl`) issues.push('证明轨迹文件名必须与 Session ID 一致');

  let trajectoryEvents = [];
  let rawEvents = [];
  try {
    trajectoryEvents = parseTrajectoryJson(String(input.trajectoryContent || ''));
  } catch (error) {
    issues.push(`证明原始轨迹无法解析：${error.message}`);
  }
  try {
    rawEvents = parseTrajectoryJson(String(input.rawStreamContent || ''));
  } catch (error) {
    issues.push(`证明运行流无法解析：${error.message}`);
  }
  const directExecutionSets = [];
  for (const [label, events, filename] of [
    ['原始轨迹', trajectoryEvents, manifest.trajectory_filename],
    ['运行流', rawEvents, ''],
  ]) {
    if (!events.length) continue;
    const validation = validateTrajectoryIntegrityEvents(events, {
      filename,
      requireFilename: Boolean(filename),
      taskName: input.taskName || '',
    });
    if (!validation.ok) issues.push(`${phase} ${label}不完整：${validation.errors.map((item) => item.message).join('；')}`);
    if (validation.stats.sessionId !== manifest.session_id) issues.push(`${phase} ${label} Session 与 manifest 不一致`);
    const commands = bashCommands(events);
    if (directCommandMode) {
      if (commands.length !== verifyCmds.length || commands.some((command, index) => command !== verifyCmds[index])) {
        issues.push(`${phase} ${label}必须将 verify_cmds 的 ${verifyCmds.length} 条命令按原文、顺序分别执行；实际 ${commands.length} 条`);
      }
      const executions = directVerificationExecutions(events);
      if (executions.some((execution) => !execution.id || !execution.hasResult || !Number.isInteger(execution.exitCode))) {
        issues.push(`${phase} ${label}存在缺少工具返回或无法确定真实退出码的验证命令`);
      }
      directExecutionSets.push({ label, executions });
    } else if (commands.length !== 1 || commands[0] !== wrapperCommand) {
      issues.push(`${phase} ${label}必须且只能执行 ${wrapperCommand}`);
    }
    if (inlineCommandMode) {
      const proofHeader = `VERIFY_PROOF phase=${phase} source_commit=${expectedSourceCommit} verify_cmds_sha256=${verifyCmdsSha256}`;
      if (!toolResultOutput(events).includes(proofHeader)) issues.push(`${phase} ${label}缺少阶段、源码 commit 与 verify_cmds 哈希证明`);
    }
  }

  const result = parseJson(input.resultContent, 'verification-result.json', issues);
  const commandResults = parseJsonLines(input.commandResultsContent, 'verification-command-results.jsonl', issues);
  if (result) {
    if (result.phase !== phase || result.result !== expectedResult) issues.push('verification-result.json 的阶段或结果不一致');
    if (Number(result.exit_code) !== (phase === 'pre_fix' ? 1 : 0)) issues.push(`${phase} verification-result.json 的 exit_code 不正确`);
  }
  if (commandResults.length !== verifyCmds.length) issues.push('验证命令结果数量与 verify_cmds 不一致');
  commandResults.forEach((record, index) => {
    const command = verifyCmds[index] || '';
    if (Number(record.index) !== index + 1 || record.command !== command) issues.push(`第 ${index + 1} 条验证命令结果与 verify_cmds 不一致`);
    if (record.kind !== verificationCommandKind(command, taskType)) issues.push(`第 ${index + 1} 条验证命令分类不正确`);
  });
  if (directCommandMode) {
    for (const { label, executions } of directExecutionSets) {
      executions.forEach((execution, index) => {
        if (execution.command !== verifyCmds[index]) return;
        if (execution.exitCode !== Number(commandResults[index]?.exit_code)) {
          issues.push(`${phase} ${label}第 ${index + 1} 条命令退出码与 verification-command-results.jsonl 不一致`);
        }
      });
    }
  }
  const infrastructure = commandResults.filter((record) => record.kind === 'infrastructure');
  const targets = commandResults.filter((record) => record.kind === 'target');
  const verification = commandResults.filter((record) => record.kind === 'verification');
  const requiresInfrastructure = verifyCmds.some((command) => /^docker\s+build\b/i.test(command));
  if ((requiresInfrastructure && !infrastructure.length) || infrastructure.some((record) => Number(record.exit_code) !== 0)) {
    issues.push('证明中的 Docker 构建没有全部成功');
  }
  if (!targets.length) issues.push('证明中缺少目标红绿验证命令');
  if (phase === 'pre_fix' && targets.some((record) => Number(record.exit_code) === 0)) issues.push('pre_fix 的目标验证没有全部呈红');
  if (phase === 'post_fix' && targets.some((record) => Number(record.exit_code) !== 0)) issues.push('post_fix 的目标验证没有全部呈绿');
  if (phase === 'post_fix' && verification.some((record) => Number(record.exit_code) !== 0)) issues.push('post_fix 的全量或静态验证未全部成功');
  if (result && (Number(result.target_total) !== targets.length || Number(result.target_failed) !== targets.filter((record) => Number(record.exit_code) !== 0).length)) {
    issues.push('verification-result.json 的目标命令统计与逐条结果不一致');
  }

  return {
    ok: issues.length === 0,
    issues,
    sessionId: String(manifest.session_id || ''),
    eventCount: trajectoryEvents.length,
    sha256: sha256(input.trajectoryContent),
  };
}
