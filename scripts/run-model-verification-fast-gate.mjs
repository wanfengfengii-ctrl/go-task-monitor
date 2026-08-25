#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
if (process.argv.length !== 5) {
  throw new Error('usage: run-model-verification-fast-gate.mjs PRISTINE WORKSPACE COVERAGE_PREFLIGHT_JSON');
}

const pristine = path.resolve(process.argv[2]);
const workspace = path.resolve(process.argv[3]);
const preflightPath = path.resolve(process.argv[4]);
const preflight = JSON.parse(await fsp.readFile(preflightPath, 'utf8'));
const plan = preflight?.plan || {};
const commands = Array.isArray(plan.verify_cmds) ? plan.verify_cmds.map(String).filter(Boolean) : [];
if (commands.length !== 1) throw new Error(`FAST_VERIFICATION_GATE: expected exactly one verify command, received ${commands.length}`);
const command = commands[0];
if (!/(?:^|\s)-count(?:=|\s+)1(?:\s|$)/.test(command)) {
  throw new Error('FAST_VERIFICATION_GATE: verify command must contain the original -count=1 replay setting');
}
const testFiles = Array.isArray(plan.verification_test_files) ? plan.verification_test_files.map(String) : [];
if (!testFiles.length) throw new Error('FAST_VERIFICATION_GATE: verification_test_files is empty');

async function projectGoEnvironment(projectDir) {
  const dockerfile = await fsp.readFile(path.join(projectDir, 'benzhi.Dockerfile'), 'utf8').catch(() => '');
  const goMod = await fsp.readFile(path.join(projectDir, 'go.mod'), 'utf8').catch(() => '');
  const dockerVersion = dockerfile.match(/^\s*FROM\s+(?:--platform=[^\s]+\s+)?golang:(\d+\.\d+(?:\.\d+)?)(?:[-\s]|$)/im)?.[1];
  const toolchainVersion = goMod.match(/^\s*toolchain\s+go(\d+\.\d+(?:\.\d+)?)(?:\s|$)/im)?.[1];
  const languageVersion = goMod.match(/^\s*go\s+(\d+\.\d+(?:\.\d+)?)(?:\s|$)/im)?.[1];
  // A two-part `go 1.23` directive is a language version, not a valid
  // GOTOOLCHAIN value. Pin only an explicit patch-level image/toolchain;
  // otherwise use the locally installed toolchain for the fast preflight.
  const version = dockerVersion || toolchainVersion || '';
  const toolchainCandidates = /^\d+\.\d+\.\d+$/.test(version)
    ? [
      process.env.GO_PIPELINE_TOOLCHAIN_BIN,
      path.resolve(import.meta.dirname, '../../.task_work/toolchains', `go${version}`, 'bin'),
      path.resolve(process.cwd(), '.task_work/toolchains', `go${version}`, 'bin'),
    ].filter(Boolean)
    : [];
  // An operator-provided path may be stale after a workspace move. Resolve a
  // real binary before deciding whether the fixed local toolchain is usable;
  // otherwise Go silently falls back to an auto-download on the host.
  const localToolchainBin = (await Promise.all(toolchainCandidates.map(async (candidate) => ({
    candidate,
    available: await fsp.stat(path.join(candidate, 'go')).then(() => true).catch(() => false),
  })))).find((entry) => entry.available)?.candidate || '';
  const localToolchainAvailable = Boolean(localToolchainBin);
  const gotoToolchain = localToolchainAvailable
    ? 'local'
    : (/^\d+\.\d+\.\d+$/.test(version) ? `go${version}` : (process.env.GOTOOLCHAIN || 'local'));
  if (/^\d+\.\d+\.\d+$/.test(version) && !localToolchainAvailable) {
    throw new Error(`FAST_VERIFICATION_GATE: fixed Go ${version} is not installed locally; refusing host toolchain auto-download`);
  }
  return {
    ...process.env,
    GOTOOLCHAIN: gotoToolchain,
    ...(localToolchainAvailable ? { PATH: `${localToolchainBin}${path.delimiter}${process.env.PATH || ''}` } : {}),
    // run_one_claude disables the checksum database for ordinary module work.
    // Toolchain auto-downloads are different: Go refuses to verify the
    // toolchain when GOSUMDB=off, so restore the public checksum service for
    // this isolated preflight (the Docker grader remains authoritative).
    GOSUMDB: process.env.GO_PIPELINE_TOOLCHAIN_GOSUMDB || 'sum.golang.org',
  };
}

async function run(label, cwd, shellCommand, { expectFailure = false, timeout = 10 * 60_000, env } = {}) {
  try {
    // Keep the project-specific PATH selected above. A login shell reloads the
    // user's profile and can silently replace the pinned Go toolchain with the
    // host Go binary, which makes valid newer projects fail this local gate.
    const result = await execFileAsync('/bin/bash', ['-c', shellCommand], {
      cwd,
      env: env || { ...process.env, GOTOOLCHAIN: process.env.GOTOOLCHAIN || 'auto' },
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (expectFailure) throw Object.assign(new Error(`${label} unexpectedly passed`), { unexpectedPass: true });
    return { exitCode: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (error) {
    const exitCode = Number.isInteger(error.code) ? error.code : 1;
    if (expectFailure && !error.unexpectedPass && exitCode !== 0) {
      return { exitCode, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    throw new Error(`${label} failed (exit=${exitCode}): ${String(error.stderr || error.stdout || error.message).slice(-4000)}`);
  }
}

const redRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'go-task-fast-red-'));
try {
  await fsp.cp(pristine, redRoot, {
    recursive: true,
    filter: (item) => !item.split(path.sep).includes('.git'),
  });
  for (const filename of testFiles) {
    if (path.isAbsolute(filename) || filename.split(/[\\/]/).includes('..')) {
      throw new Error(`FAST_VERIFICATION_GATE: unsafe test path ${filename}`);
    }
    const source = path.join(workspace, filename);
    const destination = path.join(redRoot, filename);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(source, destination);
  }

  const goEnvironment = await projectGoEnvironment(workspace);
  await run('post-fix compile preflight', workspace, "go test ./... -run '^$' -count=1", { timeout: 15 * 60_000, env: goEnvironment });
  const red = await run('BUG_BASE fast red gate', redRoot, command, { expectFailure: true, env: goEnvironment });
  const green = await run('post-fix fast green gate', workspace, command, { env: goEnvironment });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    fast_gate: { red_exit_code: red.exitCode, green_exit_code: green.exitCode },
  }, null, 2)}\n`);
} finally {
  await fsp.rm(redRoot, { recursive: true, force: true });
}
