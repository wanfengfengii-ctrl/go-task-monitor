import fs from 'node:fs/promises';
import path from 'node:path';
import { explicitDockerVerifyCmds } from './run-production-pipeline.mjs';

const tasksRoot = process.env.GO_TASK_LIBRARY_TASKS_ROOT
  || path.resolve(import.meta.dirname, '../../.task_work/go-task-library/tasks');
const apply = process.argv.includes('--apply');

function targetCommand(context) {
  const pkg = String(context?.gold_test_package || '').trim();
  const test = String(context?.gold_test_name || '').trim();
  if (!/^\.(?:\/[A-Za-z0-9_.-]+)+$/.test(pkg) || !/^Test[A-Za-z0-9_]+$/.test(test)) return '';
  return `GOTOOLCHAIN=local go test ${pkg} -run '^${test}$' -count=1`;
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

async function writeJson(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filename);
}

const changed = [];
const skipped = [];
for (const entry of (await fs.readdir(tasksRoot, { withFileTypes: true })).filter((item) => item.isDirectory())) {
  const taskDir = path.join(tasksRoot, entry.name);
  let metadata;
  try {
    metadata = await readJson(path.join(taskDir, 'public.json'));
  } catch {
    skipped.push(`${entry.name}: missing public.json`);
    continue;
  }
  if (metadata.task_type !== 'bugfix' || !Array.isArray(metadata.verify_cmds) || !metadata.verify_cmds.length) continue;
  const current = metadata.verify_cmds.join('\n');
  if (/go test[^\n]*-run\b/i.test(current)) continue;
  let context;
  try {
    context = await readJson(path.join(taskDir, 'grader/v4-context.json'));
  } catch {
    skipped.push(`${entry.name}: missing v4-context.json`);
    continue;
  }
  const focused = targetCommand(context);
  if (!focused) {
    skipped.push(`${entry.name}: missing valid Gold target test`);
    continue;
  }
  const identifier = String(metadata.sample_id || entry.name).trim();
  const replacement = explicitDockerVerifyCmds(identifier, 'bugfix', focused);
  changed.push({ name: entry.name, command: focused });
  if (apply) {
    metadata.verify_cmds = replacement;
    await writeJson(path.join(taskDir, 'public.json'), metadata);
  }
}

console.log(JSON.stringify({ apply, tasksRoot, changed, skipped }, null, 2));
