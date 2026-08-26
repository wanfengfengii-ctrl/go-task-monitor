import { findFrontendDir, inspectBugRepro, normalizePackageEntries } from './package-rules.js';
import { findRuntimeSmokeBinary } from './package-runtime-rules.js';
import { goEmbeddedDistDirectories, isGoEmbeddedDistPath } from './embedded-assets.js';
import {
  CURRENT_PROJECT_PACKAGE_POLICY_VERSION,
  MANAGED_PROJECT_PACKAGE_POLICY_VERSION,
  projectPackageRuleOptions,
  validateProjectPackagePlan,
} from './project-package-policy.js';

export const GENERATED_PACKAGE_FILES = new Set([
  'Dockerfile',
  'benzhi.Dockerfile',
  'build_benzhi_docker.sh',
  'BENZHI_README.md',
  '.dockerignore',
  '.gitignore',
]);

function toBytes(content) {
  if (content instanceof Uint8Array) return content;
  return new TextEncoder().encode(String(content || ''));
}

function bytesEqual(left, right) {
  const a = toBytes(left);
  const b = toBytes(right);
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

export function isExcludedWorkspacePath(value, embeddedDistDirs = []) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized === '.DS_Store' || normalized.endsWith('/.DS_Store')) return true;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '.git' || segment === 'node_modules')) return true;
  return segments.includes('dist') && !isGoEmbeddedDistPath(normalized, embeddedDistDirs);
}

function taskImageName(task) {
  return String(task?.bug_id || task?.name || 'go-task')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'go-task';
}

function toolchainVersion(task) {
  const matched = String(task?.go_version || '').match(/(?:^|[;\s])(?:go\s+version\s+)?go(\d+\.\d+\.\d+)\b/i);
  if (!matched) throw new Error('无法从 go_version 读取工具链补丁版本，不能生成 Git 项目支持文件');
  return matched[1];
}

function runtimePackagePath(workspaceEntries, runtimeSmokeBinary) {
  if (runtimeSmokeBinary?.packagePath) return runtimeSmokeBinary.packagePath;
  const candidates = workspaceEntries
    .filter((entry) => entry.path.endsWith('.go') && !entry.path.endsWith('_test.go') && !entry.path.startsWith('vendor/'))
    .filter((entry) => {
      const source = new TextDecoder().decode(toBytes(entry.content));
      return /^\s*package\s+main\b/m.test(source) && /^\s*func\s+main\s*\(/m.test(source);
    })
    .map((entry) => entry.path.includes('/') ? `./${entry.path.slice(0, entry.path.lastIndexOf('/'))}` : '.')
    .sort((left, right) => {
      const priority = (value) => value === '.' ? 0 : /^\.\/cmd\/(?:server|api)$/.test(value) ? 1 : value.startsWith('./cmd/') ? 2 : 3;
      return priority(left) - priority(right) || left.localeCompare(right);
    });
  return candidates[0] || '.';
}

function nodeInstallLines() {
  return [
    'RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \\',
    '    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \\',
    '    && apt-get install -y --no-install-recommends nodejs \\',
    '    && rm -rf /var/lib/apt/lists/*',
  ];
}

export function createPackageSupportFiles(task, workspaceEntries) {
  const paths = workspaceEntries.map((entry) => entry.path);
  const embeddedDistDirs = goEmbeddedDistDirectories(workspaceEntries);
  const embeddedDistExceptions = embeddedDistDirs.flatMap((directory) => [
    `!/${directory}/`,
    `!/${directory}/**`,
  ]);
  const frontendDir = findFrontendDir(paths);
  const packageOptions = projectPackageRuleOptions(task);
  const usesManagedPolicy = packageOptions.projectPackagePolicyVersion >= MANAGED_PROJECT_PACKAGE_POLICY_VERSION;
  const includesStandardDockerfile = packageOptions.projectPackagePolicyVersion >= CURRENT_PROJECT_PACKAGE_POLICY_VERSION;
  const packagePlan = validateProjectPackagePlan(task, {
    policyVersion: packageOptions.projectPackagePolicyVersion,
    frontendRequired: Boolean(frontendDir),
  });
  if (!packagePlan.ok) throw new Error(`项目包规划不符合规则：${packagePlan.issues.join('；')}`);
  const hasGoSum = paths.includes('go.sum');
  const usesVendor = paths.some((entryPath) => entryPath.startsWith('vendor/'));
  const bugReproEntry = workspaceEntries.find((entry) => entry.path === 'BUG_REPRO.md');
  const hasRuntimeSmoke = paths.includes('run_benzhi_smoke.sh');
  const bugRepro = usesManagedPolicy
    ? inspectBugRepro(`预期失败。\n\n\`\`\`bash\n${packageOptions.expectedFailureCommands.join('\n')}\n\`\`\``)
    : inspectBugRepro(bugReproEntry?.content);
  const workspaceEntryMap = new Map(workspaceEntries.map((entry) => [entry.path, entry]));
  const runtimeSmokeBinary = hasRuntimeSmoke ? findRuntimeSmokeBinary(workspaceEntryMap) : null;
  const runtimePackage = runtimePackagePath(workspaceEntries, runtimeSmokeBinary);
  const version = toolchainVersion(task);
  const imageName = taskImageName(task);
  const templateName = frontendDir ? 'frontend-v2' : 'backend-v2';
  const dockerLines = [
    `FROM golang:${version} AS benzhi-build`,
    'ARG TARGETOS=linux',
    'ARG TARGETARCH',
    'ARG GOPROXY=https://goproxy.cn,direct',
    'ENV GOPROXY=${GOPROXY}',
    'ENV GOTOOLCHAIN=local',
    'WORKDIR /src',
  ];
  // Keep the expensive Node toolchain layer independent of Go dependency
  // changes so a targeted go.mod repair can reuse it.
  if (frontendDir) dockerLines.push(...nodeInstallLines());
  dockerLines.push(hasGoSum ? 'COPY go.mod go.sum ./' : 'COPY go.mod ./');
  if (usesVendor) dockerLines.push('COPY vendor ./vendor', 'ENV GOFLAGS=-mod=vendor');
  else dockerLines.push('RUN mkdir -p /go/pkg/mod && go mod download');
  if (frontendDir) {
    dockerLines.push(
      `COPY ${frontendDir}/package*.json ./${frontendDir}/`,
      `RUN cd ${frontendDir} && npm ci`,
    );
  }
  dockerLines.push('COPY . .');
  if (frontendDir && !bugRepro.hasFrontendCommand) dockerLines.push(`RUN cd ${frontendDir} && npm run build`);
  if (!bugRepro.hasGoBuildCommand) dockerLines.push('RUN go build ./...');
  if (!bugRepro.hasGoBuildCommand) {
    dockerLines.push(`RUN mkdir -p /out && CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" ${usesVendor ? 'GOFLAGS=-mod=vendor ' : ''}go build -trimpath -o /out/benzhi-app ${runtimePackage}`);
  }
  dockerLines.push(
    '',
    `FROM golang:${version} AS benzhi-runtime`,
    `LABEL io.benzhi.delivery-template="${templateName}"`,
    'ENV GOTOOLCHAIN=local',
    'WORKDIR /app',
    ...(frontendDir ? nodeInstallLines() : []),
    'COPY --from=benzhi-build /go/pkg/mod /go/pkg/mod',
    'COPY --from=benzhi-build /src /app',
    ...(!bugRepro.hasGoBuildCommand ? ['COPY --from=benzhi-build /out/benzhi-app /usr/local/bin/benzhi-app', 'CMD ["/usr/local/bin/benzhi-app"]'] : ['CMD ["bash"]']),
    '',
  );

  const buildScript = [
    '#!/bin/bash',
    'set -euo pipefail',
    '',
    `IMAGE_NAME=\${1:-${imageName}}`,
    'DOCKER_PLATFORM=${2:-linux/amd64}',
    'BUILDX_BUILDER=${BUILDX_BUILDER:-benzhi-builder}',
    '',
    'docker buildx build --builder "$BUILDX_BUILDER" --load --progress plain --platform "$DOCKER_PLATFORM" -f benzhi.Dockerfile -t "$IMAGE_NAME:latest" .',
    '',
    'echo ""',
    'echo "Docker image \'$IMAGE_NAME:latest\' built successfully."',
    'echo ""',
    'echo "Next step: docker run --rm -it $IMAGE_NAME:latest"',
    '',
  ].join('\n');
  const localCommands = [];
  if (frontendDir) {
    localCommands.push(`npm --prefix ${frontendDir} ci`);
    if (!bugRepro.hasFrontendCommand) localCommands.push(`npm --prefix ${frontendDir} run build`);
  }
  if (!bugRepro.hasGoBuildCommand) localCommands.push(`${usesVendor ? 'GOFLAGS=-mod=vendor ' : ''}go build ./...`);
  if (runtimeSmokeBinary && !bugRepro.hasGoBuildCommand) {
    localCommands.push(`${usesVendor ? 'GOFLAGS=-mod=vendor ' : ''}go build -o ${runtimeSmokeBinary.outputPath} ${runtimeSmokeBinary.packagePath}`);
  }
  if (!bugRepro.hasGoCommand) localCommands.push(`${usesVendor ? 'GOFLAGS=-mod=vendor ' : ''}go test ./...`);
  if (!usesManagedPolicy && bugRepro.commands.length) localCommands.push('# 以下命令预期失败；详情见 BUG_REPRO.md。', ...bugRepro.commands);
  const readme = [
    ...(usesManagedPolicy ? [packageOptions.projectSummary, ''] : []),
    `# ${task?.bug_id || task?.name || 'Go task'}`,
    '',
    '本 Git 项目来自模型完成任务后的 workspace，不包含嵌套 .git 记录或本地构建产物。',
    '',
    '## 本地构建与测试',
    '',
    '```bash',
    'go mod download',
    ...localCommands,
    ...(hasRuntimeSmoke ? ['./run_benzhi_smoke.sh'] : []),
    '```',
    '',
    '## Docker 构建与运行',
    '',
    '```bash',
    ...(includesStandardDockerfile ? [`docker build --platform linux/amd64 -t ${imageName}:latest .`] : []),
    `./build_benzhi_docker.sh ${imageName} linux/arm64`,
    `docker run --rm -it --platform linux/arm64 ${imageName}:latest`,
    `./build_benzhi_docker.sh ${imageName} linux/amd64`,
    `docker run --rm -it --platform linux/amd64 ${imageName}:latest`,
    '```',
    '',
    `构建脚本第二个参数为目标平台，必须分别完成 linux/arm64 和 linux/amd64 构建与容器验证；未提供时按照规范默认使用 linux/amd64。系统 ${templateName} 模板通过 Go 原生交叉编译生成目标架构的 /usr/local/bin/benzhi-app，镜像默认直接运行该入口。`,
    ...(usesVendor ? ['', '本项目刻意使用 vendor 模式，构建命令固定 `GOFLAGS=-mod=vendor`，依赖来自项目内的 `vendor/`。'] : []),
    ...(!usesManagedPolicy && bugRepro.commands.length ? ['', '本题的容器内故障复现步骤记录在 `BUG_REPRO.md`。'] : []),
    '',
  ].join('\n');
  const dockerignore = [
    '.git',
    '.gitignore',
    '**/.DS_Store',
    '*.db',
    '*.db-*',
    '/out/',
    '/dist/',
    '**/node_modules/',
    '**/dist/',
    ...embeddedDistExceptions,
    '.benzhi-build/',
    '',
  ].join('\n');
  const gitignore = [
    '.DS_Store',
    'node_modules/',
    'dist/',
    '**/node_modules/',
    '**/dist/',
    ...embeddedDistExceptions,
    '.benzhi-build/',
    '',
  ].join('\n');
  const dockerfileContent = new TextEncoder().encode(`${dockerLines.join('\n')}`);
  return [
    ...(includesStandardDockerfile ? [{ path: 'Dockerfile', content: dockerfileContent.slice(), mode: 0o100644 }] : []),
    { path: 'benzhi.Dockerfile', content: dockerfileContent, mode: 0o100644 },
    { path: 'build_benzhi_docker.sh', content: new TextEncoder().encode(buildScript), mode: 0o100755 },
    { path: 'BENZHI_README.md', content: new TextEncoder().encode(readme), mode: 0o100644 },
    { path: '.dockerignore', content: new TextEncoder().encode(dockerignore), mode: 0o100644 },
    { path: '.gitignore', content: new TextEncoder().encode(gitignore), mode: 0o100644 },
  ];
}

export function comparePackageWithWorkspace(rawPackageEntries, rawWorkspaceEntries) {
  const { entries: packageEntries } = normalizePackageEntries(rawPackageEntries);
  const packageMap = new Map(packageEntries.map((entry) => [entry.path, entry]));
  const embeddedDistDirs = goEmbeddedDistDirectories(rawWorkspaceEntries);
  const workspaceEntries = rawWorkspaceEntries.filter((entry) => !isExcludedWorkspacePath(entry.path, embeddedDistDirs));
  const missing = [];
  const changed = [];
  for (const expected of workspaceEntries) {
    const actual = packageMap.get(expected.path);
    if (!actual) missing.push(expected.path);
    else if (!bytesEqual(actual.content, expected.content)) changed.push(expected.path);
  }
  const issues = [];
  if (missing.length) issues.push(`Git 项目不是完整的模型 workspace，缺少文件：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ` 等 ${missing.length} 个` : ''}`);
  if (changed.length) issues.push(`Git 项目文件与模型完成后的 workspace 不一致：${changed.slice(0, 5).join('、')}${changed.length > 5 ? ` 等 ${changed.length} 个` : ''}`);
  return { ok: issues.length === 0, issues, checkedFiles: workspaceEntries.length, missing, changed };
}
