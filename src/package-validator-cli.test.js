import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArguments, validateTarget } from '../scripts/validate-go-package.mjs';

test('package validator CLI enables Docker by default and supports static mode', () => {
  assert.deepEqual(parseArguments(['project']), {
    docker: true,
    target: 'project',
    baseline: '',
    platforms: ['linux/arm64', 'linux/amd64'],
    projectPackagePolicyVersion: 1,
    projectType: '',
    projectSummary: '',
  });
  assert.equal(parseArguments(['--static-only', 'project']).docker, false);
  assert.equal(parseArguments(['--baseline=/tmp/pristine', '--static-only', 'project']).baseline, '/tmp/pristine');
  assert.deepEqual(parseArguments(['--platform=linux/amd64', 'project']).platforms, ['linux/amd64']);
  assert.throws(() => parseArguments(['--platform=windows/amd64', 'project']), /只支持/);
  assert.throws(() => parseArguments(['--baseline=', 'project']), /baseline/);
  assert.throws(() => parseArguments(['--zero-to-one', 'project']), /未知参数/);
  const current = parseArguments([
    '--package-policy-version=2',
    '--project-type=web',
    '--project-summary=基于 Go 实现的订单管理 Web 项目，一款后端服务，处理订单创建与状态流转。',
    'project',
  ]);
  assert.equal(current.projectPackagePolicyVersion, 2);
  assert.equal(current.projectType, 'web');
});

test('package validator baseline mode accepts old issues and rejects new ones', async (context) => {
  const baseline = await fs.mkdtemp(path.join(os.tmpdir(), 'package-validator-baseline-'));
  const candidate = await fs.mkdtemp(path.join(os.tmpdir(), 'package-validator-candidate-'));
  context.after(() => Promise.all([
    fs.rm(baseline, { recursive: true, force: true }),
    fs.rm(candidate, { recursive: true, force: true }),
  ]));
  const files = {
    'go.mod': 'module example.com/task\n\ngo 1.22\n',
    'main.go': 'package main\nfunc main() {}\n',
    'benzhi.Dockerfile': 'FROM golang:1.22\nENV GOTOOLCHAIN=local\nWORKDIR /app\nCOPY . .\nRUN go build ./...\nCMD ["bash"]\n',
    'build_benzhi_docker.sh': '#!/bin/bash\nset -e\nIMAGE_NAME=${1:-my-project}\nDOCKER_PLATFORM=${2:-linux/amd64}\ndocker build --platform "$DOCKER_PLATFORM" -f benzhi.Dockerfile -t "$IMAGE_NAME:latest" .\n',
    'BENZHI_README.md': '# Task\n\n基线校验项目。\n\n```sh\ngo build ./...\ngo test ./...\n./build_benzhi_docker.sh task linux/arm64\ndocker run -it --platform linux/arm64 task:latest\n./build_benzhi_docker.sh task linux/amd64\ndocker run -it --platform linux/amd64 task:latest\n```\n',
    'run_benzhi_smoke.sh': '#!/usr/bin/env bash\nset -euo pipefail\ncurl -fsS http://127.0.0.1:8080/ | grep -q ready\n',
  };
  for (const directory of [baseline, candidate]) {
    await Promise.all(Object.entries(files).map(([filename, content]) => fs.writeFile(path.join(directory, filename), content)));
  }

  const grandfathered = await validateTarget(candidate, { docker: false, baseline });
  assert.equal(grandfathered.ok, true);
  assert.deepEqual(grandfathered.static.introducedIssues, []);
  assert.ok(grandfathered.baseline.grandfatheredIssues.some((issue) => issue.includes('SIGPIPE')));

  await fs.mkdir(path.join(candidate, 'node_modules'));
  const introduced = await validateTarget(candidate, { docker: false, baseline });
  assert.equal(introduced.ok, false);
  assert.ok(introduced.static.introducedIssues.some((issue) => issue.includes('node_modules')));
});

test('package validator CLI rejects node_modules and dist directories', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'package-validator-artifacts-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = {
    'go.mod': 'module example.com/task\n\ngo 1.22\n',
    'main.go': 'package main\nfunc main() {}\n',
    'benzhi.Dockerfile': 'FROM golang:1.22\nENV GOTOOLCHAIN=local\nWORKDIR /app\nCOPY . .\nRUN go build ./...\nCMD ["bash"]\n',
    'build_benzhi_docker.sh': '#!/bin/bash\nset -e\nIMAGE_NAME=${1:-my-project}\nDOCKER_PLATFORM=${2:-linux/amd64}\ndocker build --platform "$DOCKER_PLATFORM" -f benzhi.Dockerfile -t "$IMAGE_NAME:latest" .\n',
    'BENZHI_README.md': '# Task\n\n这是一个用于检查构建产物目录的 Go 项目。\n\n```sh\ngo build ./...\ngo test ./...\n./build_benzhi_docker.sh task linux/arm64\ndocker run -it --platform linux/arm64 task:latest\n./build_benzhi_docker.sh task linux/amd64\ndocker run -it --platform linux/amd64 task:latest\n```\n',
  };
  await Promise.all(Object.entries(files).map(([filename, content]) => fs.writeFile(path.join(directory, filename), content)));
  await fs.mkdir(path.join(directory, 'web/node_modules'), { recursive: true });
  await fs.writeFile(path.join(directory, 'web/node_modules/package.json'), '{}');
  await fs.mkdir(path.join(directory, 'dist'), { recursive: true });
  await fs.writeFile(path.join(directory, 'dist/app'), 'compiled');
  const report = await validateTarget(directory, { docker: false });
  assert.equal(report.ok, false);
  assert.ok(report.static.issues.some((issue) => issue.includes('node_modules')));
  assert.ok(report.static.issues.some((issue) => issue.includes('dist')));
});

test('package validator CLI validates a dependency-free directory without Docker', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'package-validator-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = {
    'go.mod': 'module example.com/task\n\ngo 1.22\n',
    'main.go': 'package main\nfunc main() {}\n',
    'benzhi.Dockerfile': 'FROM golang:1.22\nENV GOTOOLCHAIN=local\nWORKDIR /app\nCOPY . .\nRUN go build ./...\nCMD ["bash"]\n',
    'build_benzhi_docker.sh': '#!/bin/bash\nset -e\nIMAGE_NAME=${1:-my-project}\nDOCKER_PLATFORM=${2:-linux/amd64}\ndocker build --platform "$DOCKER_PLATFORM" -f benzhi.Dockerfile -t "$IMAGE_NAME:latest" .\n',
    'BENZHI_README.md': '# Task\n\n这是一个无外部依赖的 Go 示例项目，用于校验项目打包规范。\n\n```sh\ngo build ./...\ngo test ./...\n./build_benzhi_docker.sh task linux/arm64\ndocker run -it --platform linux/arm64 task:latest\n./build_benzhi_docker.sh task linux/amd64\ndocker run -it --platform linux/amd64 task:latest\n```\n',
  };
  await Promise.all(Object.entries(files).map(([filename, content]) => fs.writeFile(path.join(directory, filename), content)));
  const report = await validateTarget(directory, { docker: false });
  assert.equal(report.ok, true);
  assert.equal(report.static.fileCount, 5);
  assert.equal(report.docker.attempted, false);
});

test('package validator CLI emits JSON when its script path contains spaces', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'package validator cli test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'go.mod'), 'module example.com/task\n\ngo 1.22\n');
  const script = fileURLToPath(new URL('../scripts/validate-go-package.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--static-only', directory], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.static.issues.length > 0);
});
