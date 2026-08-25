#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { MAX_BUG_COUNT, markPipelineBugSkipped } from '../src/pipeline-rules.js';

async function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filename);
}

async function main() {
  const [jobFileInput, bugIndexInput, ...reasonParts] = process.argv.slice(2);
  if (!jobFileInput || !bugIndexInput) {
    throw new Error('用法：node scripts/skip-pipeline-bug.mjs <job.json> <bug-index> [reason]');
  }
  const jobFile = path.resolve(jobFileInput);
  const bugIndex = Number(bugIndexInput);
  if (!Number.isInteger(bugIndex) || bugIndex < 1 || bugIndex > MAX_BUG_COUNT) {
    throw new Error(`bug-index 必须是 1-${MAX_BUG_COUNT} 的整数`);
  }
  const job = JSON.parse(await fs.readFile(jobFile, 'utf8'));
  const reason = reasonParts.join(' ').trim() || '轨迹连续未通过规范，人工决定跳过';
  const at = new Date().toISOString();
  markPipelineBugSkipped(job, bugIndex, reason, at);
  job.logs = [...(job.logs || []), {
    at,
    level: 'warn',
    stageId: `bug${bugIndex}_delivery_ready`,
    message: `Bug ${bugIndex} 已人工跳过：${reason}`,
  }].slice(-200);
  await writeJsonAtomic(jobFile, job);
  process.stdout.write(`${job.id} Bug ${bugIndex} 已标记为 skipped\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
