#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { goTestNames, verificationTestNamesFromCommand } from '../src/model-verification.js';

if (process.argv.length !== 4) {
  throw new Error('usage: prepare-diagnosis-verification.mjs REPOSITORY PUBLIC_JSON');
}

const repository = path.resolve(process.argv[2]);
const metadata = JSON.parse(await fsp.readFile(path.resolve(process.argv[3]), 'utf8'));
const commands = Array.isArray(metadata.verify_cmds)
  ? metadata.verify_cmds
  : String(metadata.verify_cmds || '').split(/\r?\n/).filter(Boolean);
const requestedNames = [...new Set(commands.flatMap(verificationTestNamesFromCommand))].sort();
if (!requestedNames.length) throw new Error('diagnosis verify_cmds 必须包含明确的 Go 测试名称');

const testFiles = execFileSync('git', ['-C', repository, 'ls-files', '--', '*_test.go'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean);
const sources = await Promise.all(testFiles.map(async (filename) => ({
  path: filename,
  content: await fsp.readFile(path.join(repository, filename), 'utf8'),
})));
const matched = sources.filter((entry) => {
  const names = new Set(goTestNames(entry.content));
  return requestedNames.some((name) => names.has(name));
});
const foundNames = new Set(matched.flatMap((entry) => goTestNames(entry.content)));
const missingNames = requestedNames.filter((name) => !foundNames.has(name));
if (missingNames.length) throw new Error(`diagnosis verify_cmds 指向的公开测试不存在：${missingNames.join('、')}`);

const plan = {
  verification_test_overlay: 'repository-tests',
  verification_test_files: matched.map((entry) => entry.path).sort(),
  verification_test_names: requestedNames,
  verification_test_manifest: matched.map((entry) => ({
    path: entry.path,
    sha256: crypto.createHash('sha256').update(entry.content).digest('hex'),
  })).sort((left, right) => left.path.localeCompare(right.path)),
};
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
