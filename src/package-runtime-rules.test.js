import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTAINER_SHELL_ARGS, createContainerVerificationPlan, findRuntimeSmokeBinary } from './package-runtime-rules.js';

test('container verification preserves the image PATH with a non-login shell', () => {
  assert.deepEqual(CONTAINER_SHELL_ARGS, ['bash', '-c']);
});

test('healthy package is rebuilt offline inside the container', () => {
  const plan = createContainerVerificationPlan([
    { path: 'go.mod', content: 'module example.com/task\n\ngo 1.23\n' },
  ]);
  assert.match(plan.script, /GOPROXY=off go mod download/);
  assert.match(plan.script, /GOPROXY=off go build \.\/\.\.\./);
  assert.match(plan.script, /GOPROXY=off go test \.\/\.\.\./);
  assert.match(plan.script, /GOPROXY=off go vet \.\/\.\.\./);
  assert.match(plan.script, /\[verify\] offline module cache/);
  assert.equal(plan.expectsFailure, false);
});

test('BUG_REPRO command must fail for container verification to pass', () => {
  const plan = createContainerVerificationPlan([
    { path: 'go.mod', content: 'module example.com/task\n\ngo 1.23\n' },
    { path: 'BUG_REPRO.md', content: '# Repro\n\n以下命令预期失败。\n\n```bash\ngo test ./...\n```\n' },
  ]);
  assert.match(plan.script, /go test \.\/\.\.\./);
  assert.match(plan.script, /unexpectedly succeeded/);
  assert.equal(plan.expectsFailure, true);
});

test('current package policy ignores file-based reproduction and uses task metadata', () => {
  const entries = [
    { path: 'go.mod', content: 'module example.com/task\n\ngo 1.23\n' },
    { path: 'BUG_REPRO.md', content: '# Repro\n\n预期失败。\n\n```bash\ngo build ./...\n```\n' },
  ];
  const normal = createContainerVerificationPlan(entries, '', {
    projectPackagePolicyVersion: 2,
  });
  assert.equal(normal.expectsFailure, false);
  assert.match(normal.script, /GOPROXY=off go test \.\/\.\.\./);

  const expectedFailure = createContainerVerificationPlan(entries, '', {
    projectPackagePolicyVersion: 2,
    expectedFailureCommands: ['go test ./...'],
  });
  assert.equal(expectedFailure.expectsFailure, true);
  assert.deepEqual(expectedFailure.commands, ['go test ./...']);
  assert.match(expectedFailure.script, /Expected-failure command unexpectedly succeeded/);
});

test('generated 0-1 verification performs offline build, test, and vet checks', () => {
  const plan = createContainerVerificationPlan([
    { path: 'go.mod', content: 'module example.com/task\n\ngo 1.23\n' },
  ]);
  assert.match(plan.script, /go version/);
  assert.match(plan.script, /GOPROXY=off go mod download/);
  assert.match(plan.script, /GOPROXY=off go build \.\/\.\.\./);
  assert.match(plan.script, /GOPROXY=off go test \.\/\.\.\./);
  assert.match(plan.script, /GOPROXY=off go vet \.\/\.\.\./);
});

test('container verification executes a generated project runtime smoke script', () => {
  const plan = createContainerVerificationPlan([
    { path: 'go.mod', content: 'module example.com/task\n\ngo 1.23\n' },
    { path: 'run_benzhi_smoke.sh', content: '#!/usr/bin/env bash\nset -e\ngo run ./cmd/task --help\n' },
  ]);
  assert.equal(plan.runtimeSmokeFile, 'run_benzhi_smoke.sh');
  assert.match(plan.script, /bash \.\/run_benzhi_smoke\.sh/);
});

test('container verification builds a smoke service binary before running it', () => {
  const plan = createContainerVerificationPlan([
    { path: 'go.mod', content: 'module example.com/task\n\ngo 1.23\n' },
    { path: 'cmd/maintbridge/main.go', content: 'package main\nfunc main() {}\n' },
    { path: 'run_benzhi_smoke.sh', content: '#!/usr/bin/env bash\nset -e\n"${PWD}/bin/maintbridge"\n' },
  ]);
  assert.deepEqual(plan.runtimeSmokeBinary, {
    name: 'maintbridge',
    packagePath: './cmd/maintbridge',
    outputPath: './bin/maintbridge',
  });
  assert.match(plan.script, /mkdir -p bin && GOPROXY=off go build -o \.\/bin\/maintbridge \.\/cmd\/maintbridge/);
});

test('container verification builds a root-level binary when the smoke script requires it', () => {
  const plan = createContainerVerificationPlan([
    { path: 'go.mod', content: 'module example.com/task\n\ngo 1.23\n' },
    { path: 'cmd/quorumforge/main.go', content: 'package main\nfunc main() {}\n' },
    {
      path: 'run_benzhi_smoke.sh',
      content: '#!/usr/bin/env bash\nset -e\n# Docker may also install /usr/local/bin/quorumforge\nROOT_DIR="$(pwd)"\n"${ROOT_DIR}/quorumforge"\n',
    },
  ]);
  assert.deepEqual(plan.runtimeSmokeBinary, {
    name: 'quorumforge',
    packagePath: './cmd/quorumforge',
    outputPath: './quorumforge',
  });
  assert.match(plan.script, /GOPROXY=off go build -o \.\/quorumforge \.\/cmd\/quorumforge/);
});

test('runtime smoke binary detection ignores paths without a matching cmd package', () => {
  const entries = new Map([
    ['run_benzhi_smoke.sh', { content: '"${PWD}/bin/service"' }],
    ['cmd/other/main.go', { content: 'package main' }],
  ]);
  assert.equal(findRuntimeSmokeBinary(entries), null);
});

test('frontend build does not change the working directory before root smoke', () => {
  const plan = createContainerVerificationPlan([
    { path: 'go.mod', content: 'module example.com/task\n\ngo 1.23\n' },
    { path: 'web/package.json', content: '{"scripts":{"build":"vite build"}}' },
    { path: 'web/package-lock.json', content: '{}' },
    { path: 'run_benzhi_smoke.sh', content: '#!/usr/bin/env bash\nset -e\n' },
  ], 'web');
  assert.match(plan.script, /npm --prefix "web" run build\necho "\[verify\] go build"/);
  assert.match(plan.script, /GOPROXY=off go vet \.\/\.\.\.\necho "\[verify\] runtime smoke"\nbash \.\/run_benzhi_smoke\.sh/);
  assert.doesNotMatch(plan.script, /cd web && npm run build/);
  assert.doesNotMatch(plan.script, /test -d .*node_modules/);
  assert.ok(plan.script.indexOf('[verify] frontend build') < plan.script.indexOf('[verify] go build'));
});

test('dependency-free frontend does not require a node_modules directory', () => {
  const plan = createContainerVerificationPlan([
    { path: 'go.mod', content: 'module example.com/task\n\ngo 1.23\n' },
    { path: 'web/package.json', content: '{"scripts":{"build":"node scripts/build.js"}}' },
    { path: 'web/package-lock.json', content: '{"lockfileVersion":3,"packages":{"":{"name":"web"}}}' },
  ], 'web');
  assert.match(plan.script, /\[verify\] frontend build/);
  assert.doesNotMatch(plan.script, /node_modules/);
});
