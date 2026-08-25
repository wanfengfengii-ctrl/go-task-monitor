#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalizeClaudeTranscript, createTrajectoryManifest, serializeCanonicalTrajectory } from '../src/trajectory-v4.js';
import { parseTrajectoryJson } from '../src/trajectory-file-validator.js';

function parseArgs(args) {
  const values = {};
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/s);
    if (!match) throw new Error(`参数格式错误：${arg}`);
    values[match[1]] = match[2];
  }
  for (const key of ['native', 'stream', 'prompt', 'audit', 'output', 'manifest', 'task-type']) {
    if (!values[key]) throw new Error(`缺少 --${key}`);
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [rawNativeContent, rawStreamContent, promptFileContent, auditContent] = await Promise.all([
    fs.readFile(args.native, 'utf8'),
    fs.readFile(args.stream, 'utf8'),
    fs.readFile(args.prompt, 'utf8'),
    fs.readFile(args.audit, 'utf8'),
  ]);
  const expectedPrompt = promptFileContent.trim();
  const canonical = canonicalizeClaudeTranscript(parseTrajectoryJson(rawNativeContent), { expectedPrompt });
  const deliveryContent = serializeCanonicalTrajectory(canonical.events);
  const deliveryFilename = path.basename(args.output);
  const rawFilename = path.basename(args.native);
  const manifest = createTrajectoryManifest({
    sessionId: canonical.sessionId,
    taskType: args['task-type'],
    prompt: canonical.prompt,
    rawNativeContent,
    rawStreamContent,
    deliveryContent,
    auditContent,
    deliveryFilename,
    rawFilename,
    rawEventCount: canonical.rawEventCount,
    eventCount: canonical.events.length,
    goVersion: args['go-version'] || '',
  });
  await Promise.all([
    fs.writeFile(args.output, deliveryContent, { encoding: 'utf8', mode: 0o444 }),
    fs.writeFile(args.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o444 }),
  ]);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
