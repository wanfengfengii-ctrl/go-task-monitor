#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { buildModelVerificationPlan } from '../src/model-verification.js';

if (process.argv.length !== 5) {
  throw new Error('usage: prepare-model-verification.mjs REPOSITORY BUG_BASE_COMMIT V4_CONTEXT');
}

const repository = path.resolve(process.argv[2]);
const bugBaseCommit = process.argv[3];
const contextPath = path.resolve(process.argv[4]);
const changed = execFileSync('git', ['-C', repository, 'diff', '--cached', '--name-only', '--diff-filter=ACMR', bugBaseCommit, '--', '*_test.go'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean);
if (!changed.length) throw new Error('bugfix 必须新增或修改至少一个 Go 回归测试文件');

const sources = await Promise.all(changed.map(async (filename) => ({
  path: filename,
  content: await fsp.readFile(path.join(repository, filename), 'utf8'),
})));
const context = JSON.parse(await fsp.readFile(contextPath, 'utf8').catch(() => '{}'));
const plan = buildModelVerificationPlan(sources, { concurrency: Boolean(context.concurrency) });
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
