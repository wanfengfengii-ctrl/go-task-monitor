#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseTrajectoryJson, validateTrajectoryIntegrityEvents } from '../src/trajectory-file-validator.js';
import { directVerificationExecutions, verificationCommandKind } from '../src/verification-proof.js';

const [phase, metadataPath, nativePath, streamPath, outputDir] = process.argv.slice(2);
if (!['pre_fix', 'post_fix'].includes(phase) || !metadataPath || !nativePath || !streamPath || !outputDir) {
  console.error('usage: extract-verification-results.mjs PHASE PUBLIC_JSON NATIVE_JSONL STREAM_JSONL OUTPUT_DIR');
  process.exit(2);
}

const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
const taskType = String(metadata.task_type || '');
if (!['bugfix', 'diagnosis'].includes(taskType)) throw new Error('public.json task_type must be bugfix or diagnosis');
const verifyCmds = Array.isArray(metadata.verify_cmds) ? metadata.verify_cmds.map(String) : [];
if (!verifyCmds.length || verifyCmds.some((command) => !command.trim())) throw new Error('public.json verify_cmds must be a non-empty string array');

const [nativeContent, streamContent] = await Promise.all([
  fsp.readFile(nativePath, 'utf8'),
  fsp.readFile(streamPath, 'utf8'),
]);

function inspect(content, label) {
  const events = parseTrajectoryJson(content);
  const validation = validateTrajectoryIntegrityEvents(events, { requireFilename: false });
  if (!validation.ok) throw new Error(`${label} is incomplete: ${validation.errors.map((issue) => issue.message).join('; ')}`);
  const executions = directVerificationExecutions(events);
  if (executions.length !== verifyCmds.length) throw new Error(`${label} executed ${executions.length} Bash commands; expected ${verifyCmds.length}`);
  executions.forEach((execution, index) => {
    if (execution.command !== verifyCmds[index]) throw new Error(`${label} command ${index + 1} does not match immutable verify_cmds`);
    if (!execution.id || !execution.hasResult) throw new Error(`${label} command ${index + 1} has no paired tool result`);
    if (!Number.isInteger(execution.exitCode)) throw new Error(`${label} command ${index + 1} has no trustworthy exit code`);
  });
  return { validation, executions };
}

const native = inspect(nativeContent, 'Claude native trajectory');
const stream = inspect(streamContent, 'Claude stream');
if (native.validation.stats.sessionId !== stream.validation.stats.sessionId) throw new Error('native trajectory and stream use different Session IDs');
native.executions.forEach((execution, index) => {
  if (execution.exitCode !== stream.executions[index].exitCode) throw new Error(`command ${index + 1} exit code differs between native trajectory and stream`);
});

const records = native.executions.map((execution, index) => ({
  index: index + 1,
  command: execution.command,
  kind: verificationCommandKind(execution.command, taskType),
  exit_code: execution.exitCode,
}));
const infrastructure = records.filter((record) => record.kind === 'infrastructure');
const targets = records.filter((record) => record.kind === 'target');
const verification = records.filter((record) => record.kind === 'verification');
const infrastructureFailed = infrastructure.filter((record) => record.exit_code !== 0).length;
const targetFailed = targets.filter((record) => record.exit_code !== 0).length;
const verificationFailed = verification.filter((record) => record.exit_code !== 0).length;

let result = 'invalid';
let exitCode = 22;
const requiresInfrastructure = verifyCmds.some((command) => /^docker\s+build\b/i.test(command));
if ((requiresInfrastructure && !infrastructure.length) || infrastructureFailed > 0 || !targets.length) {
  result = 'infrastructure_error';
  exitCode = 20;
} else if (phase === 'pre_fix' && targetFailed === targets.length) {
  result = 'red';
  exitCode = 1;
} else if (phase === 'post_fix' && targetFailed === 0 && verificationFailed === 0) {
  result = 'green';
  exitCode = 0;
}

const summary = {
  phase,
  result,
  exit_code: exitCode,
  target_total: targets.length,
  target_failed: targetFailed,
  infrastructure_failed: infrastructureFailed,
  verification_failed: verificationFailed,
};
await fsp.mkdir(outputDir, { recursive: true });
await Promise.all([
  fsp.writeFile(path.join(outputDir, 'verification-command-results.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8'),
  fsp.writeFile(path.join(outputDir, 'verification-result.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
]);
process.stdout.write(`${JSON.stringify({ session_id: native.validation.stats.sessionId, ...summary })}\n`);
