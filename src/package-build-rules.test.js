import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePackageWithWorkspace, createPackageSupportFiles, isExcludedWorkspacePath } from './package-build-rules.js';
import { validateGoPackage } from './package-rules.js';

const bytes = (value) => new TextEncoder().encode(value);

test('generated package files use the model toolchain and cloud-compatible platform parameters', () => {
  const files = createPackageSupportFiles({ bug_id: 'sample-task', go_version: 'go1.25.6; go.mod go 1.23' }, [
    { path: 'go.mod', content: bytes('module example.com/task\n\ngo 1.23\n') },
  ]);
  const map = new Map(files.map((file) => [file.path, new TextDecoder().decode(file.content)]));
  assert.match(map.get('benzhi.Dockerfile'), /^FROM golang:1\.25\.6 AS benzhi-build/m);
  assert.doesNotMatch(map.get('benzhi.Dockerfile'), /BUILDPLATFORM/);
  assert.match(map.get('benzhi.Dockerfile'), /^LABEL io\.benzhi\.delivery-template="backend-v2"/m);
  assert.match(map.get('benzhi.Dockerfile'), /ARG GOPROXY=https:\/\/goproxy\.cn,direct/);
  assert.match(map.get('benzhi.Dockerfile'), /ENV GOPROXY=\$\{GOPROXY\}/);
  assert.doesNotMatch(map.get('benzhi.Dockerfile'), /^# syntax=/m);
  assert.match(map.get('benzhi.Dockerfile'), /RUN mkdir -p \/go\/pkg\/mod && go mod download/);
  assert.doesNotMatch(map.get('benzhi.Dockerfile'), /mount=type=cache|cp -a \/cache/);
  assert.match(map.get('benzhi.Dockerfile'), /ARG TARGETOS=linux/);
  assert.match(map.get('benzhi.Dockerfile'), /ARG TARGETARCH/);
  assert.match(map.get('benzhi.Dockerfile'), /CGO_ENABLED=0 GOOS="\$TARGETOS" GOARCH="\$TARGETARCH"/);
  assert.match(map.get('benzhi.Dockerfile'), /CMD \["\/usr\/local\/bin\/benzhi-app"\]/);
  assert.match(map.get('build_benzhi_docker.sh'), /DOCKER_PLATFORM=\$\{2:-linux\/amd64\}/);
  assert.match(map.get('build_benzhi_docker.sh'), /docker buildx build --builder "\$BUILDX_BUILDER" --load --progress plain --platform "\$DOCKER_PLATFORM"/);
  assert.match(map.get('BENZHI_README.md'), /模型完成任务后的 workspace/);
  assert.match(map.get('BENZHI_README.md'), /linux\/arm64/);
  assert.match(map.get('BENZHI_README.md'), /linux\/amd64/);
  assert.match(map.get('.dockerignore'), /^\.git$/m);
  assert.doesNotMatch(map.get('.dockerignore'), /_test\.go|testdata/);
  assert.match(map.get('.dockerignore'), /\*\*\/node_modules\//);
  assert.match(map.get('.gitignore'), /\*\*\/dist\//);
});

test('v3 package support includes an identical standard Dockerfile', () => {
  const task = {
    bug_id: 'standard-dockerfile-task',
    go_version: 'go1.25.6; go.mod go 1.25',
    project_package_policy_version: 3,
    project_type: 'web',
    project_summary: '基于 Go 实现的订单管理 Web 项目，一款后端服务，处理订单创建、状态流转与商家数据管理。',
  };
  const workspace = [
    { path: 'go.mod', content: bytes('module example.com/task\n\ngo 1.25\n') },
    { path: 'main.go', content: bytes('package main\nfunc main() {}\n') },
  ];
  const files = createPackageSupportFiles(task, workspace);
  const map = new Map(files.map((file) => [file.path, new TextDecoder().decode(file.content)]));
  assert.equal(map.get('Dockerfile'), map.get('benzhi.Dockerfile'));
  assert.match(map.get('BENZHI_README.md'), /docker build --platform linux\/amd64 -t standard-dockerfile-task:latest \./);
  assert.deepEqual(validateGoPackage([...workspace, ...files], {
    projectPackagePolicyVersion: 3,
    projectType: task.project_type,
    projectSummary: task.project_summary,
  }).issues, []);
});

test('current system template is statically valid and rejects external Dockerfile syntax frontends', () => {
  const workspace = [
    { path: 'go.mod', content: bytes('module example.com/task\n\ngo 1.25\n') },
    { path: 'main.go', content: bytes('package main\nfunc main() {}\n') },
  ];
  const generated = createPackageSupportFiles({ bug_id: 'template-task', go_version: 'go1.25.6; go.mod go 1.25' }, workspace);
  const valid = validateGoPackage([...workspace, ...generated]);
  assert.deepEqual(valid.issues, []);
  const withSyntax = generated.map((entry) => entry.path === 'benzhi.Dockerfile'
    ? { ...entry, content: bytes(`# syntax=docker/dockerfile:1\n${new TextDecoder().decode(entry.content)}`) }
    : entry);
  assert.equal(validateGoPackage([...workspace, ...withSyntax]).issues.some((issue) => issue.includes('# syntax=')), true);
});

test('generated frontend Dockerfile installs Node.js 20', () => {
  const files = createPackageSupportFiles({ bug_id: 'frontend-task', go_version: 'go1.25.6; go.mod go 1.23' }, [
    { path: 'go.mod', content: bytes('module example.com/task\n\ngo 1.23\n') },
    { path: 'web/package.json', content: bytes('{"scripts":{"build":"vite build"}}') },
    { path: 'web/package-lock.json', content: bytes('{}') },
  ]);
  const dockerfile = new TextDecoder().decode(files.find((file) => file.path === 'benzhi.Dockerfile').content);
  assert.match(dockerfile, /setup_20\.x/);
  assert.match(dockerfile, /^LABEL io\.benzhi\.delivery-template="frontend-v2"/m);
  assert.match(dockerfile, /npm ci/);
  assert.match(dockerfile, /npm run build/);
  assert.ok(dockerfile.indexOf('setup_20.x') < dockerfile.indexOf('COPY go.mod'));
});

test('generated frontend Dockerfile supports a project-specific frontend directory', () => {
  const files = createPackageSupportFiles({ bug_id: 'ui-task', go_version: 'go1.25.6; go.mod go 1.23' }, [
    { path: 'go.mod', content: bytes('module example.com/task\n\ngo 1.23\n') },
    { path: 'ui/package.json', content: bytes('{"scripts":{"build":"vite build"}}') },
    { path: 'ui/package-lock.json', content: bytes('{}') },
  ]);
  const dockerfile = new TextDecoder().decode(files.find((file) => file.path === 'benzhi.Dockerfile').content);
  assert.match(dockerfile, /COPY ui\/package\*\.json/);
  assert.match(dockerfile, /cd ui && npm ci/);
});

test('system ignore templates retain dist assets required by Go embed', () => {
  const files = createPackageSupportFiles({ bug_id: 'embedded-ui', go_version: 'go1.25.6; go.mod go 1.23' }, [
    { path: 'go.mod', content: bytes('module example.com/task\n\ngo 1.23\n') },
    { path: 'web/package.json', content: bytes('{"scripts":{"build":"node build.mjs"}}') },
    { path: 'web/package-lock.json', content: bytes('{}') },
    { path: 'webembed/assets.go', content: bytes('package webembed\nimport "embed"\n//go:embed all:dist\nvar assets embed.FS\n') },
  ]);
  const map = new Map(files.map((file) => [file.path, new TextDecoder().decode(file.content)]));
  assert.match(map.get('.gitignore'), /!\/webembed\/dist\/\n!\/webembed\/dist\/\*\*/);
  assert.match(map.get('.dockerignore'), /!\/webembed\/dist\/\n!\/webembed\/dist\/\*\*/);
  assert.ok(map.get('BENZHI_README.md').indexOf('npm --prefix web run build') < map.get('BENZHI_README.md').indexOf('go build ./...'));
});

test('generated Dockerfile omits an intentionally failing build recorded in BUG_REPRO', () => {
  const files = createPackageSupportFiles({ bug_id: 'broken-build', go_version: 'go1.25.6; go.mod go 1.23' }, [
    { path: 'go.mod', content: bytes('module example.com/task\n\ngo 1.23\n') },
    { path: 'BUG_REPRO.md', content: bytes('# Repro\n\n预期失败。\n\n```bash\ngo build ./...\n```\n') },
  ]);
  const dockerfile = new TextDecoder().decode(files.find((file) => file.path === 'benzhi.Dockerfile').content);
  assert.doesNotMatch(dockerfile, /RUN go build \.\/\.\.\./);
});

test('generated 0-1 support files retain real Go build and test commands', () => {
  const files = createPackageSupportFiles({ bug_id: 'zero-to-one', project_origin: 'generated_0to1', go_version: 'go1.25.6; go.mod go 1.23' }, [
    { path: 'go.mod', content: bytes('module example.com/task\n\ngo 1.23\n') },
    { path: 'main.go', content: bytes('package main\nfunc main() {}\n') },
  ]);
  const dockerfile = new TextDecoder().decode(files.find((file) => file.path === 'benzhi.Dockerfile').content);
  const readme = new TextDecoder().decode(files.find((file) => file.path === 'BENZHI_README.md').content);
  assert.match(dockerfile, /RUN .*go build \.\/\.\.\./);
  assert.match(readme, /linux\/arm64/);
  assert.match(readme, /linux\/amd64/);
  assert.match(readme, /go build \.\/\.\.\./);
  assert.match(readme, /go test \.\/\.\.\./);
});

test('current package policy writes the exact introduction and no BUG_REPRO guidance', () => {
  const projectSummary = '基于 Go 实现的停车场管理 CLI 项目，一款命令行工具，完成车位录入、车辆进出登记与费用核算。';
  const task = {
    bug_id: 'current-package',
    go_version: 'go1.25.6; go.mod go 1.23',
    project_package_policy_version: 2,
    project_type: 'cli',
    project_summary: projectSummary,
    task_type: 'diagnosis',
    verify_cmds: ['go build ./...'],
  };
  const files = createPackageSupportFiles(task, [
    { path: 'go.mod', content: bytes('module example.com/task\n\ngo 1.23\n') },
  ]);
  const map = new Map(files.map((file) => [file.path, new TextDecoder().decode(file.content)]));
  assert.equal(map.get('BENZHI_README.md').split('\n', 1)[0], projectSummary);
  assert.doesNotMatch(map.get('BENZHI_README.md'), /BUG_REPRO|go build \.\/\.\.\./);
  assert.doesNotMatch(map.get('benzhi.Dockerfile'), /RUN go build \.\/\.\.\./);
});

test('go test reproduction keeps the normal go build layer', () => {
  const files = createPackageSupportFiles({ bug_id: 'broken-test', go_version: 'go1.25.6; go.mod go 1.23' }, [
    { path: 'go.mod', content: bytes('module example.com/task\n\ngo 1.23\n') },
    { path: 'BUG_REPRO.md', content: bytes('# Repro\n\n预期失败。\n\n```bash\ngo test ./...\n```\n') },
  ]);
  const dockerfile = new TextDecoder().decode(files.find((file) => file.path === 'benzhi.Dockerfile').content);
  assert.match(dockerfile, /RUN .*go build \.\/\.\.\./);
});

test('intentional vendor mode is retained and documented', () => {
  const workspace = [
    { path: 'go.mod', content: bytes('module example.com/task\n\ngo 1.23\n') },
    { path: 'vendor/modules.txt', content: bytes('# vendored dependencies\n') },
  ];
  const files = createPackageSupportFiles({ bug_id: 'vendor-task', go_version: 'go1.25.6; go.mod go 1.23' }, workspace);
  const map = new Map(files.map((file) => [file.path, new TextDecoder().decode(file.content)]));
  assert.match(map.get('benzhi.Dockerfile'), /ENV GOFLAGS=-mod=vendor/);
  assert.match(map.get('BENZHI_README.md'), /刻意使用 vendor 模式/);
  assert.equal(isExcludedWorkspacePath('vendor/modules.txt'), false);
});

test('workspace package comparison rejects pristine or changed source', () => {
  const workspace = [
    { path: 'go.mod', content: bytes('module example.com/task\n\ngo 1.23\n') },
    { path: 'fixed.go', content: bytes('package task\nconst Fixed = true\n') },
  ];
  const valid = comparePackageWithWorkspace(workspace, workspace);
  assert.equal(valid.ok, true);
  const stale = comparePackageWithWorkspace([
    workspace[0],
    { path: 'fixed.go', content: bytes('package task\nconst Fixed = false\n') },
  ], workspace);
  assert.match(stale.issues[0], /workspace 不一致/);
});

test('Git workspace excludes build artifacts but retains committed delivery files', () => {
  assert.equal(isExcludedWorkspacePath('.git/config'), true);
  assert.equal(isExcludedWorkspacePath('web/node_modules/pkg/index.js'), true);
  assert.equal(isExcludedWorkspacePath('build_benzhi_docker.sh'), false);
  assert.equal(isExcludedWorkspacePath('Dockerfile'), false);
  assert.equal(isExcludedWorkspacePath('benzhi.Dockerfile'), false);
  assert.equal(isExcludedWorkspacePath('BENZHI_README.md'), false);
  assert.equal(isExcludedWorkspacePath('pkg/task.go'), false);
  assert.equal(isExcludedWorkspacePath('webembed/dist/index.html', ['webembed/dist']), false);
  assert.equal(isExcludedWorkspacePath('webembed/dist/node_modules/pkg/index.js', ['webembed/dist']), true);
});
