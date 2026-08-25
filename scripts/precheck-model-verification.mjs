#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { buildModelVerificationPlan } from '../src/model-verification.js';
import { verificationCoverageChecklistIssues } from '../src/verification-coverage-checklist.js';

if (![5, 6].includes(process.argv.length)) {
  throw new Error('usage: precheck-model-verification.mjs PRISTINE WORKSPACE CHECKLIST_JSON [V4_CONTEXT]');
}

const pristine = path.resolve(process.argv[2]);
const workspace = path.resolve(process.argv[3]);
const checklistPath = path.resolve(process.argv[4]);
const contextPath = process.argv[5] ? path.resolve(process.argv[5]) : '';

async function testFiles(root, relative = '') {
  const result = [];
  const entries = await fsp.readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (['.git', 'node_modules', 'vendor'].includes(entry.name)) continue;
    const filename = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await testFiles(root, filename));
    else if (entry.isFile() && entry.name.endsWith('_test.go')) result.push(filename);
  }
  return result;
}

const candidates = await testFiles(workspace);
const sources = [];
for (const filename of candidates) {
  const current = await fsp.readFile(path.join(workspace, filename), 'utf8');
  const before = await fsp.readFile(path.join(pristine, filename), 'utf8').catch(() => null);
  if (before === current) continue;
  sources.push({ path: filename, content: current });
}

const context = contextPath
  ? JSON.parse(await fsp.readFile(contextPath, 'utf8').catch(() => '{}'))
  : {};
let plan;
try {
  plan = buildModelVerificationPlan(sources, { concurrency: Boolean(context.concurrency) });
} catch (error) {
  throw new Error(`COVERAGE_PREFLIGHT: ${error.message}。请在当前 workspace 补充 TestModel_ 回归测试后重新运行。`);
}
const checklist = JSON.parse(await fsp.readFile(checklistPath, 'utf8'));
const missing = verificationCoverageChecklistIssues(checklist, sources);
if (missing.length) {
  throw new Error(`COVERAGE_PREFLIGHT: 公开 TestModel_ 提交前覆盖清单缺项：${missing.join('；')}。请保留当前修复，只补齐对应公开测试及断言后重新运行定向 go test。`);
}

process.stdout.write(`${JSON.stringify({ ok: true, plan, checked_entries: checklist.entries?.length || 0 }, null, 2)}\n`);
