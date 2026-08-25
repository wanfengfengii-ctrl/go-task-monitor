#!/usr/bin/env node
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateGoPackage, validateGoPackageAgainstBaseline } from '../src/package-rules.js';
import { CONTAINER_SHELL_ARGS, createContainerVerificationPlan } from '../src/package-runtime-rules.js';

const VALIDATION_PLATFORMS = ['linux/arm64', 'linux/amd64'];

function parseArguments(args) {
  const options = {
    docker: true,
    target: '',
    baseline: '',
    platforms: [],
    projectPackagePolicyVersion: 1,
    projectType: '',
    projectSummary: '',
  };
  for (const arg of args) {
    if (arg === '--static-only' || arg === '--no-docker') options.docker = false;
    else if (arg === '--docker') options.docker = true;
    else if (arg.startsWith('--baseline=')) options.baseline = arg.slice('--baseline='.length);
    else if (arg.startsWith('--platform=')) options.platforms.push(arg.slice('--platform='.length));
    else if (arg.startsWith('--package-policy-version=')) options.projectPackagePolicyVersion = Number(arg.slice('--package-policy-version='.length));
    else if (arg.startsWith('--project-type=')) options.projectType = arg.slice('--project-type='.length);
    else if (arg.startsWith('--project-summary=')) options.projectSummary = arg.slice('--project-summary='.length);
    else if (!arg.startsWith('-') && !options.target) options.target = arg;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!options.target) throw new Error('请提供 Git 项目目录');
  if (args.some((arg) => arg.startsWith('--baseline=')) && !options.baseline) throw new Error('--baseline 不能为空');
  if (!Number.isInteger(options.projectPackagePolicyVersion) || options.projectPackagePolicyVersion < 1) throw new Error('--package-policy-version 必须是正整数');
  if (options.platforms.some((platform) => !VALIDATION_PLATFORMS.includes(platform))) {
    throw new Error(`--platform 只支持 ${VALIDATION_PLATFORMS.join('、')}`);
  }
  options.platforms = options.platforms.length ? [...new Set(options.platforms)] : [...VALIDATION_PLATFORMS];
  return options;
}

async function readDirectoryEntries(root) {
  const entries = [];
  async function visit(directory, relative = '') {
    for (const child of (await fsp.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      if (child.name === '.git' || child.name === '.DS_Store') continue;
      if (child.isDirectory() && ['node_modules', 'dist'].includes(child.name)) {
        entries.push({ path: `${childRelative}/.forbidden`, content: new Uint8Array() });
        continue;
      }
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) await visit(absolute, childRelative);
      else if (child.isFile()) entries.push({ path: childRelative, content: await fsp.readFile(absolute) });
    }
  }
  await visit(root);
  return entries;
}

async function readTarget(target) {
  const stat = await fsp.stat(target);
  if (stat.isDirectory()) return readDirectoryEntries(target);
  throw new Error('目标必须是 Git 项目目录；不再接受 ZIP 交付');
}

function run(command, args, cwd, onProgress = null) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const observe = (stream, chunk) => {
      const text = String(chunk);
      output += text;
      if (typeof onProgress === 'function') onProgress({ command, args, stream, text });
    };
    child.stdout.on('data', (chunk) => observe('stdout', chunk));
    child.stderr.on('data', (chunk) => observe('stderr', chunk));
    child.once('error', (error) => resolve({ exitCode: null, output: `${output}\n${error.message}` }));
    child.once('close', (exitCode) => resolve({ exitCode, output }));
  });
}

async function validateTarget(target, options = {}) {
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  progress({ phase: 'static', message: '开始静态交付校验' });
  const entries = await readTarget(target);
  const ruleOptions = {
    projectPackagePolicyVersion: options.projectPackagePolicyVersion,
    projectType: options.projectType,
    projectSummary: options.projectSummary,
  };
  const staticResult = validateGoPackage(entries, ruleOptions);
  let baseline = null;
  let introducedIssues = staticResult.issues;
  if (options.baseline) {
    const baselineEntries = await readTarget(path.resolve(options.baseline));
    const comparison = validateGoPackageAgainstBaseline(entries, baselineEntries, ruleOptions);
    const baselineResult = comparison.baseline;
    introducedIssues = comparison.introducedIssues;
    baseline = {
      target: path.resolve(options.baseline),
      ok: baselineResult.ok,
      issues: baselineResult.issues,
      grandfatheredIssues: comparison.grandfatheredIssues,
      introducedIssues,
    };
  }
  const staticAccepted = options.baseline ? introducedIssues.length === 0 : staticResult.ok;
  const platforms = Array.isArray(options.platforms) && options.platforms.length
    ? [...new Set(options.platforms)]
    : [...VALIDATION_PLATFORMS];
  if (platforms.some((platform) => !VALIDATION_PLATFORMS.includes(platform))) {
    throw new Error(`Docker 校验平台只支持 ${VALIDATION_PLATFORMS.join('、')}`);
  }
  const docker = { attempted: false, ok: true, platforms, results: [] };
  if (options.docker !== false && staticAccepted) {
    docker.attempted = true;
    const script = path.join(target, 'build_benzhi_docker.sh');
    const verificationPlan = createContainerVerificationPlan(entries, staticResult.frontendDir, ruleOptions);
    const runId = crypto.randomBytes(6).toString('hex');
    for (const platform of docker.platforms) {
      progress({ phase: 'docker_build', platform, message: `开始 ${platform} 镜像构建` });
      const imageName = `go-task-validator-${runId}-${platform.replace('/', '-')}`;
      const imageReference = `${imageName}:latest`;
      const build = await run(script, [imageName, platform], target, progress);
      progress({ phase: 'docker_verify', platform, message: `开始 ${platform} 容器验证` });
      const verify = build.exitCode === 0
        ? await run('docker', ['run', '--rm', '--network', 'none', '--platform', platform, imageReference, ...CONTAINER_SHELL_ARGS, verificationPlan.script], target, progress)
        : { exitCode: null, output: '跳过容器验证：镜像构建失败' };
      const cleanup = await run('docker', ['image', 'rm', '-f', imageReference], target, progress);
      docker.results.push({ platform, imageReference, build, verify, cleanup, exitCode: verify.exitCode ?? build.exitCode, output: [build.output, verify.output].filter(Boolean).join('\n') });
      if (build.exitCode !== 0 || verify.exitCode !== 0) docker.ok = false;
      progress({ phase: 'docker_complete', platform, message: `${platform} 校验${build.exitCode === 0 && verify.exitCode === 0 ? '通过' : '失败'}` });
    }
  }
  return {
    ok: staticAccepted && docker.ok,
    static: { ...staticResult, accepted: staticAccepted, introducedIssues, fileCount: entries.filter((entry) => !entry.path.endsWith('/')).length },
    baseline,
    docker,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = await validateTarget(path.resolve(options.target), {
      ...options,
      onProgress(event) {
        if (event?.message) process.stderr.write(`[validator] ${event.message}\n`);
        else if (event?.text) process.stderr.write(event.text);
      },
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

export { parseArguments, validateTarget };
