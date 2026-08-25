#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { directPublicVerifyCommandIssues } from '../src/verification-proof.js';

if (process.argv.length !== 4) {
  throw new Error('usage: configure-claude-model-grader.mjs TASK_DIR COVERAGE_PREFLIGHT_JSON');
}

const taskDir = path.resolve(process.argv[2]);
const preflightPath = path.resolve(process.argv[3]);
const preflight = JSON.parse(await fsp.readFile(preflightPath, 'utf8'));
const plan = preflight?.plan;
const commands = Array.isArray(plan?.verify_cmds) ? plan.verify_cmds.map(String).map((value) => value.trim()).filter(Boolean) : [];
const issues = directPublicVerifyCommandIssues(commands, 'bugfix');
if (issues.length) throw new Error(`Claude 公开回归命令不合格：${issues.join('；')}`);
if (commands.length !== 1) throw new Error(`Claude 公开回归命令必须且只能有一条，实际 ${commands.length} 条`);

const testFiles = Array.isArray(plan?.verification_test_files)
  ? plan.verification_test_files.map(String).map((value) => value.trim()).filter(Boolean)
  : [];
if (!testFiles.length) throw new Error('Claude 公开回归测试缺少 verification_test_files');

const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const target = `#!/usr/bin/env bash
set -euo pipefail
workspace="$(cd "\${1:?workspace is required}" && pwd)"
cd "$workspace"
GOTOOLCHAIN=local /bin/bash -c ${shellQuote(commands[0])}
`;
const graderDir = path.join(taskDir, 'grader');
await fsp.mkdir(graderDir, { recursive: true });
await Promise.all([
  fsp.writeFile(path.join(graderDir, 'run_target.sh'), target, { mode: 0o755 }),
  fsp.writeFile(path.join(graderDir, 'test-files.txt'), `${testFiles.join('\n')}\n`, 'utf8'),
  fsp.writeFile(path.join(graderDir, 'model-verification-preflight.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8'),
]);

const publicPath = path.join(taskDir, 'public.json');
const metadata = JSON.parse(await fsp.readFile(publicPath, 'utf8'));
metadata.verify_cmds = commands;
metadata.verification_test_overlay = plan.verification_test_overlay || 'repository-tests';
metadata.verification_test_files = testFiles;
metadata.verification_test_names = Array.isArray(plan.verification_test_names) ? plan.verification_test_names : [];
metadata.verification_test_manifest = plan.verification_test_manifest || [];
metadata.model_verification_policy_version = Number(plan.policy_version || 0);
metadata.verification_evidence = {};
delete metadata.verify_result;
await fsp.writeFile(publicPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

process.stdout.write(`${JSON.stringify({ ok: true, command: commands[0], test_files: testFiles })}\n`);
