#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
}

async function filesWithExtension(directory, extension) {
  const files = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesWithExtension(filename, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(filename);
  }
  return files;
}

for (const filename of await filesWithExtension(root, '.sh')) run('/bin/bash', ['-n', filename]);
for (const filename of [path.join(root, 'server.mjs'), ...await filesWithExtension(path.join(root, 'scripts'), '.mjs')]) {
  run(process.execPath, ['--check', filename]);
}

const runner = await fsp.readFile(path.join(root, 'run_one_claude.sh'), 'utf8');
for (const required of ['run-docker-task-grader.sh', 'backend=docker-target', '.claude-run.lock', '[[ -f "$publish_checkpoint/mutation-audit.jsonl" ]]']) {
  if (!runner.includes(required)) throw new Error(`Claude Runner 缺少部署契约：${required}`);
}

console.log('Preflight syntax and runner contract checks passed.');
