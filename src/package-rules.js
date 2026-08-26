import { goEmbeddedDistDirectories, isGoEmbeddedDistPath } from './embedded-assets.js';
import {
  CURRENT_PROJECT_PACKAGE_POLICY_VERSION,
  MANAGED_PROJECT_PACKAGE_POLICY_VERSION,
  isBugReproPath,
  projectPackageRuleOptions,
  validateReadmeProjectIntroduction,
} from './project-package-policy.js';

export const PACKAGE_REQUIRED_FILES = [
  'go.mod',
  'benzhi.Dockerfile',
  'build_benzhi_docker.sh',
  'BENZHI_README.md',
];

const ANSWER_ARTIFACT_PATH_PATTERN = /(?:^|\/)(?:gold|grader|hidden[-_]?tests?|solutions?|answers?|patches?)(?:\/|$)/i;
const MODEL_INSTRUCTION_PATH_PATTERN = /(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|\.claude(?:\/|$))/i;
const ANSWER_MARKER_PATTERN = /gold_root_cause|gold\.patch|hidden grader|BUG_BASE|injected bug|intentional benchmark bug/i;

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

function asText(content) {
  if (typeof content === 'string') return content;
  if (content instanceof Uint8Array) return new TextDecoder().decode(content);
  return String(content || '');
}

// Accept a shell-expanded port as well as a literal port. Generated smoke
// scripts commonly use http://127.0.0.1:${PORT}; it remains loopback-only.
const LOOPBACK_AUTHORITY_PATTERN = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(?:\d+|\$\{?[A-Z_][A-Z0-9_]*\}?))?(?:[/?#]|$)/i;

function loopbackVariables(text) {
  const variables = new Set();
  const assignmentPattern = /(?:^|\n)\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*["']([^"']*)["']/gm;
  for (const match of text.matchAll(assignmentPattern)) {
    const value = match[2].trim();
    const authority = value.replace(/^https?:\/\//i, '');
    if (LOOPBACK_AUTHORITY_PATTERN.test(authority)) variables.add(match[1]);
  }
  return variables;
}

export function smokeUsesExternalNetwork(content) {
  const text = asText(content);
  const safeVariables = loopbackVariables(text);
  for (const match of text.matchAll(/https?:\/\/([^\s"'`<>()]+)/gi)) {
    const authority = match[1];
    if (LOOPBACK_AUTHORITY_PATTERN.test(authority)) continue;
    const variable = authority.match(/^\$\{?([A-Z_][A-Z0-9_]*)\}?/);
    if (variable && safeVariables.has(variable[1])) continue;
    return true;
  }
  return false;
}

function isCompiledBinary(content) {
  if (!(content instanceof Uint8Array) || content.length < 4) return false;
  const magic = [...content.slice(0, 4)].map((value) => value.toString(16).padStart(2, '0')).join('');
  return ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe'].includes(magic)
    || (content[0] === 0x4d && content[1] === 0x5a);
}

export function findFrontendDir(paths) {
  const candidates = [...new Set(paths
    .map((value) => normalizePath(value))
    .filter((value) => value.endsWith('/package.json') && !value.split('/').includes('node_modules'))
    .map((value) => value.slice(0, -'/package.json'.length))
    .filter((directory) => directory && !directory.includes('/')))];
  return ['web', 'frontend'].find((directory) => candidates.includes(directory)) || candidates[0] || '';
}

export function inspectBugRepro(content) {
  const text = asText(content).trim();
  if (!text) return { commands: [], hasGoCommand: false, hasGoBuildCommand: false, hasFrontendCommand: false, declaresExpectedFailure: false };
  const fencedBlocks = [...text.matchAll(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/gi)].map((match) => match[1]);
  const commandSource = fencedBlocks.length ? fencedBlocks.join('\n') : text;
  const commands = commandSource
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\$\s*/, ''))
    .filter((line) => /(?:^|&&\s*)(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*(?:go\s+(?:build|test|run)\b|npm\s+run\s+build\b)/.test(line));
  return {
    commands,
    hasGoCommand: commands.some((line) => /(?:^|\s)go\s+(?:build|test|run)\b/.test(line)),
    hasGoBuildCommand: commands.some((line) => /(?:^|\s)go\s+build\b/.test(line)),
    hasFrontendCommand: commands.some((line) => /npm\s+run\s+build\b/.test(line)),
    declaresExpectedFailure: /(?:预期|应当|应该).{0,20}(?:失败|报错|错误)|(?:失败|报错|错误).{0,20}(?:复现|预期)|expected.{0,20}(?:fail|error)/i.test(text),
  };
}

function inspectExpectedFailureCommands(commands, declaresExpectedFailure = false) {
  const normalized = Array.isArray(commands) ? commands : [];
  return {
    commands: normalized,
    hasGoCommand: normalized.some((line) => /(?:^|\s)go\s+(?:build|test|run)\b/.test(line)),
    hasGoBuildCommand: normalized.some((line) => /(?:^|\s)go\s+build\b/.test(line)),
    hasFrontendCommand: normalized.some((line) => /npm\s+(?:--prefix\s+[^\s]+\s+)?run\s+build\b/.test(line)),
    declaresExpectedFailure,
  };
}

export function normalizePackageEntries(entries) {
  const visible = entries
    .map((entry) => ({ ...entry, path: normalizePath(entry.path) }))
    .filter((entry) => entry.path && !entry.path.endsWith('/') && !entry.path.startsWith('__MACOSX/') && !entry.path.endsWith('/.DS_Store') && entry.path !== '.DS_Store');
  const paths = visible.map((entry) => entry.path);
  const firstSegments = new Set(paths.filter((value) => value.includes('/')).map((value) => value.split('/', 1)[0]));
  const hasRootFile = paths.some((value) => !value.includes('/'));
  const rootPrefix = !hasRootFile && firstSegments.size === 1 ? `${[...firstSegments][0]}/` : '';
  return {
    rootPrefix,
    entries: visible.map((entry) => ({ ...entry, path: rootPrefix ? entry.path.slice(rootPrefix.length) : entry.path })),
  };
}

export function validateGoPackage(rawEntries, options = {}) {
  const { enforcePinnedToolchain = true } = options;
  const packageOptions = projectPackageRuleOptions(options);
  const usesManagedPolicy = packageOptions.projectPackagePolicyVersion >= MANAGED_PROJECT_PACKAGE_POLICY_VERSION;
  const requiresStandardDockerfile = packageOptions.projectPackagePolicyVersion >= CURRENT_PROJECT_PACKAGE_POLICY_VERSION;
  const { rootPrefix, entries } = normalizePackageEntries(rawEntries);
  const entryMap = new Map(entries.map((entry) => [entry.path, entry]));
  const paths = [...entryMap.keys()];
  const embeddedDistDirs = goEmbeddedDistDirectories(entries);
  const issues = [];
  const policyIssues = [];
  const warnings = [];
  const add = (message) => { if (!issues.includes(message)) issues.push(message); };
  const addPolicy = (message) => {
    add(message);
    if (!policyIssues.includes(message)) policyIssues.push(message);
  };

  for (const filename of PACKAGE_REQUIRED_FILES) {
    if (!entryMap.has(filename)) add(`Git 项目根目录缺少 ${filename}`);
  }
  if (requiresStandardDockerfile && !entryMap.has('Dockerfile')) addPolicy('Git 项目根目录缺少 Dockerfile');
  const goMod = asText(entryMap.get('go.mod')?.content);
  const hasModuleDependencies = /^\s*require(?:\s|\()/im.test(goMod);
  if (entryMap.has('go.mod') && !/^\s*go\s+\d+\.\d+(?:\.\d+)?\s*(?:\/\/[^\n]*)?$/im.test(goMod)) add('go.mod 必须包含明确的 go 语言版本指令（例如 go 1.23）');
  if (hasModuleDependencies && !entryMap.has('go.sum')) add('go.mod 声明了依赖，Git 项目根目录必须包含 go.sum');
  if (!paths.some((value) => value.endsWith('.go') && !value.startsWith('vendor/'))) add('Git 项目中没有 Go 源码文件；0-1 项目也必须包含可编译的 Go 基础代码');

  const readme = asText(entryMap.get('BENZHI_README.md')?.content);
  const vendorAllowed = /(?:-mod=vendor|GOFLAGS\s*=\s*[^\n]*-mod=vendor)/i.test(readme) && /vendor/i.test(readme);
  if (paths.some((value) => value.split('/').includes('node_modules'))) add('Git 提交不能包含 node_modules');
  if (paths.some((value) => value.split('/').includes('dist') && !isGoEmbeddedDistPath(value, embeddedDistDirs))) add('Git 提交不能包含 dist 编译产物');
  if (paths.some((value) => value.split('/').includes('.git'))) add('交付内容不能嵌套 .git 目录或额外 Git 记录');
  if (!vendorAllowed && paths.some((value) => value.startsWith('vendor/'))) add('Git 提交不能包含 vendor；确需 vendor 模式时必须在 BENZHI_README.md 写明 -mod=vendor 和原因');
  for (const entry of entries) if (isCompiledBinary(entry.content)) add(`Git 提交不能包含已编译二进制：${entry.path}`);

  const frontendDir = findFrontendDir(paths);
  if (frontendDir && !entryMap.has(`${frontendDir}/package-lock.json`)) add(`${frontendDir}/ 缺少 package-lock.json`);

  const dockerfile = asText(entryMap.get('benzhi.Dockerfile')?.content);
  const standardDockerfile = asText(entryMap.get('Dockerfile')?.content);
  const dockerignore = asText(entryMap.get('.dockerignore')?.content);
  const bugReproEntries = entries.filter((entry) => isBugReproPath(entry.path));
  if (usesManagedPolicy && bugReproEntries.length) {
    addPolicy(`新项目不能包含 BUG_REPRO.md：${bugReproEntries.slice(0, 3).map((entry) => entry.path).join('、')}`);
  }
  const bugRepro = usesManagedPolicy
    ? inspectExpectedFailureCommands(packageOptions.expectedFailureCommands, packageOptions.expectedFailureCommands.length > 0)
    : inspectBugRepro(entryMap.get('BUG_REPRO.md')?.content);
  const ignoredDockerTestPaths = dockerignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .filter((line) => /(?:^|\/)testdata(?:\/|$)|_test\.go(?:$|\s)/i.test(line));
  if (ignoredDockerTestPaths.length) add(`.dockerignore 不能排除公开测试源码或 testdata：${ignoredDockerTestPaths.slice(0, 3).join('、')}`);
  if (!usesManagedPolicy && entryMap.has('BUG_REPRO.md') && !bugRepro.commands.length) add('BUG_REPRO.md 必须在 shell 代码块中写明用于复现故障的 go build、go test、go run 或 npm run build 命令');
  if (!usesManagedPolicy && entryMap.has('BUG_REPRO.md') && !bugRepro.declaresExpectedFailure) add('BUG_REPRO.md 必须明确说明复现命令预期失败或报错');
  if (requiresStandardDockerfile && entryMap.has('Dockerfile') && dockerfile && standardDockerfile !== dockerfile) {
    addPolicy('Dockerfile 必须与系统维护的 benzhi.Dockerfile 完全一致');
  }
  if (dockerfile) {
    if (/^\s*#\s*syntax\s*=/im.test(dockerfile)) add('benzhi.Dockerfile 禁止使用外部 # syntax= 前端指令，必须使用系统维护的内置 Dockerfile 语法');
    const fromLines = dockerfile.match(/^\s*FROM\s+[^\n]+/gim) || [];
    const templateMatch = dockerfile.match(/^\s*LABEL\s+io\.benzhi\.delivery-template=["']?(backend-v2|frontend-v2)["']?\s*$/im);
    const systemTemplate = templateMatch?.[1] || '';
    if (systemTemplate) {
      if (fromLines.length !== 2) add('系统 Docker 交付模板必须包含 benzhi-build 与 benzhi-runtime 两个固定阶段');
      if (!/^\s*FROM\s+golang:[^\s]+\s+AS\s+benzhi-build\s*$/im.test(dockerfile)) add('系统 Docker 模板构建阶段必须兼容不注入 BUILDPLATFORM 的云端 Docker builder');
      if (!/^\s*FROM\s+golang:[^\s]+\s+AS\s+benzhi-runtime\s*$/im.test(dockerfile)) add('系统 Docker 模板必须使用固定 benzhi-runtime 运行阶段');
      if (frontendDir && systemTemplate !== 'frontend-v2') add('包含前端的项目必须使用系统 frontend-v2 Docker 模板');
      if (!frontendDir && systemTemplate !== 'backend-v2') add('纯后端项目必须使用系统 backend-v2 Docker 模板');
    } else if (fromLines.length !== 1) add('非系统模板的 benzhi.Dockerfile 必须使用单阶段完整 Go 镜像');
    if (!/^\s*FROM\s+(?:--platform=\$BUILDPLATFORM\s+)?golang:[^\s]+(?:\s|$)/im.test(dockerfile)) add('benzhi.Dockerfile 必须基于包含完整 Go 工具链的官方 golang 镜像');
    if (enforcePinnedToolchain && !/^\s*ENV\s+GOTOOLCHAIN\s*=\s*local\s*$/im.test(dockerfile)) add('benzhi.Dockerfile 必须设置 ENV GOTOOLCHAIN=local，禁止容器自动下载其他 Go 工具链');
    const toolchainVersion = goMod.match(/^\s*toolchain\s+go(\d+\.\d+(?:\.\d+)?)\s*$/im)?.[1] || '';
    const goLanguageVersion = goMod.match(/^\s*go\s+(\d+\.\d+(?:\.\d+)?)\s*(?:\/\/[^\n]*)?$/im)?.[1] || '';
    const dockerToolchainVersion = dockerfile.match(/^\s*FROM\s+(?:--platform=[^\s]+\s+)?golang:(\d+\.\d+(?:\.\d+)?)(?:[-\s]|$)/im)?.[1] || '';
    if (toolchainVersion) {
      const toolchainSeries = toolchainVersion.split('.').slice(0, 2).join('.');
      const languageSeries = goLanguageVersion.split('.').slice(0, 2).join('.');
      const dockerSeries = dockerToolchainVersion.split('.').slice(0, 2).join('.');
      if (languageSeries && Number(toolchainSeries.split('.')[0]) * 100 + Number(toolchainSeries.split('.')[1]) < Number(languageSeries.split('.')[0]) * 100 + Number(languageSeries.split('.')[1])) {
        add(`go.mod 的 toolchain go${toolchainVersion} 不能低于 go 语言版本 ${goLanguageVersion}`);
      }
      if (enforcePinnedToolchain && dockerSeries && dockerSeries !== toolchainSeries) add(`go.mod 的 toolchain go${toolchainVersion} 必须与 Docker golang:${dockerToolchainVersion} 属于同一 Go 版本系列`);
      if (enforcePinnedToolchain && dockerToolchainVersion.split('.').length === 3 && dockerToolchainVersion !== toolchainVersion) add(`go.mod 的 toolchain go${toolchainVersion} 必须与 Docker 固定工具链 go${dockerToolchainVersion} 完全一致`);
    }
    if (/^\s*FROM\s+--platform\s*=\s*linux\/(?:amd64|arm64)\b/im.test(dockerfile)) add('benzhi.Dockerfile 不能写死 linux/amd64 或 linux/arm64，架构必须由 build_benzhi_docker.sh 的目标平台参数决定');
    // Dockerfile RUN instructions commonly use a trailing backslash. Flatten
    // only those continuations before checking the command; otherwise the
    // generated cache-friendly multiline RUN is reported as missing.
    const dockerfileLogicalLines = dockerfile.replace(/\\[ \t]*(?:\r?\n|$)/g, ' ');
    if (!/^\s*RUN\b[^\n]*\bgo\s+mod\s+download\b/im.test(dockerfileLogicalLines) && !vendorAllowed && hasModuleDependencies) add('benzhi.Dockerfile 必须在构建阶段执行 go mod download；仅无外部依赖或明确使用 -mod=vendor 时可以例外');
    if (!/RUN[^\n]*\bgo\s+build\s+\.\/\.\.\./i.test(dockerfile) && !bugRepro.hasGoBuildCommand) {
      add(usesManagedPolicy
        ? 'benzhi.Dockerfile 必须执行 go build ./...；仅任务元数据明确声明构建预期失败时可以例外'
        : 'benzhi.Dockerfile 必须执行 go build ./...；若题目故意保留 Go 构建 Bug，需用 BUG_REPRO.md 说明复现命令和预期失败');
    }
    if (systemTemplate && !bugRepro.hasGoBuildCommand) {
      if (!/^\s*ARG\s+TARGETOS(?:=linux)?\s*$/im.test(dockerfile) || !/^\s*ARG\s+TARGETARCH\s*$/im.test(dockerfile)) add('系统 Docker 模板必须声明 TARGETOS 与 TARGETARCH');
      if (!/CGO_ENABLED=0[^\n]*GOOS=[^\n]*\$TARGETOS[^\n]*GOARCH=[^\n]*\$TARGETARCH[^\n]*go\s+build[^\n]*-o\s+\/out\/benzhi-app/i.test(dockerfile)) add('系统 Docker 模板必须使用 Go 原生交叉编译生成 /out/benzhi-app');
      if (!/^\s*CMD\s+\[\s*["']\/usr\/local\/bin\/benzhi-app["']\s*\]\s*$/im.test(dockerfile)) add('系统 Docker 模板必须默认运行 /usr/local/bin/benzhi-app');
    } else if (!/^\s*CMD\s+(?:\[\s*["']bash["']\s*\]|["']?bash["']?)\s*$/im.test(dockerfile)) add('构建故障复现模板应使用 bash 作为容器默认入口');
    if (frontendDir) {
      const escapedFrontendDir = frontendDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!/setup_20\.x|node(?:js)?(?:\s|:|-)*20/i.test(dockerfile)) add('Go + 前端项目的 benzhi.Dockerfile 必须按模板安装 Node.js 20');
      if (!new RegExp(`COPY\\s+${escapedFrontendDir}/package\\*\\.json`, 'i').test(dockerfile)) add(`benzhi.Dockerfile 必须先复制 ${frontendDir}/package*.json 以缓存前端依赖`);
      if (!new RegExp(`(?:cd|--prefix)\\s+${escapedFrontendDir}[^\\n]*npm\\s+(?:ci|install)`, 'i').test(dockerfile)) add(`benzhi.Dockerfile 必须在构建阶段通过 npm ci 或 npm install 预装 ${frontendDir}/ 前端依赖`);
      if (!new RegExp(`(?:cd|--prefix)\\s+${escapedFrontendDir}[^\\n]*npm\\s+run\\s+build`, 'i').test(dockerfile) && !bugRepro.hasFrontendCommand) {
        add(usesManagedPolicy
          ? `benzhi.Dockerfile 必须验证 ${frontendDir}/ 前端构建；仅任务元数据明确声明前端构建预期失败时可以例外`
          : `benzhi.Dockerfile 必须验证 ${frontendDir}/ 前端构建；若题目故意保留前端构建 Bug，需用 BUG_REPRO.md 说明复现命令和预期失败`);
      }
    }
  }

  const buildScript = asText(entryMap.get('build_benzhi_docker.sh')?.content);
  if (buildScript) {
    if (!/^#!(?:\/bin\/bash|\/usr\/bin\/env\s+bash)\b/m.test(buildScript)) add('build_benzhi_docker.sh 必须使用 bash shebang');
    if (!/^\s*set\s+-[^\n]*e/m.test(buildScript)) add('build_benzhi_docker.sh 必须启用 set -e，任一命令失败时立即退出');
    if (!/\$\{1:-[^}]+\}/.test(buildScript)) add('build_benzhi_docker.sh 第一个参数必须是镜像名并提供默认值');
    if (!/\$\{2:-linux\/amd64\}/.test(buildScript)) add('build_benzhi_docker.sh 第二个参数必须是目标平台，默认 linux/amd64');
    if (!/docker\s+(?:build|buildx\s+build)\b/i.test(buildScript)) add('build_benzhi_docker.sh 必须执行 docker build 或 docker buildx build');
    if (!/docker\s+(?:build|buildx\s+build)[^\n]*--platform\s+(?:"?\$DOCKER_PLATFORM"?|"?\$\{DOCKER_PLATFORM\}"?)/i.test(buildScript)) add('build_benzhi_docker.sh 必须通过 --platform 使用第二个目标平台参数');
    if (/io\.benzhi\.delivery-template=/i.test(dockerfile) && !/docker\s+buildx\s+build[^\n]*--builder\s+"?\$BUILDX_BUILDER"?/i.test(buildScript)) add('系统 Docker 模板必须使用共享 BUILDX_BUILDER 构建池');
    if (!/(?:^|\s)-f\s+["']?benzhi\.Dockerfile["']?(?:\s|$)/m.test(buildScript)) add('build_benzhi_docker.sh 必须使用 -f benzhi.Dockerfile，不能覆盖或误用项目原 Dockerfile');
    if (!/(?:^|\s)-t\s+["']?\$IMAGE_NAME:latest["']?(?:\s|$)/m.test(buildScript)) add('build_benzhi_docker.sh 必须将镜像标记为 $IMAGE_NAME:latest');
  }

  const smokeScript = asText(entryMap.get('run_benzhi_smoke.sh')?.content);
  if (smokeScript) {
    if (!/^#!(?:\/bin\/bash|\/usr\/bin\/env\s+bash)\b/m.test(smokeScript)) add('run_benzhi_smoke.sh 必须使用 bash shebang');
    if (!/^\s*set\s+-[^\n]*e/m.test(smokeScript)) add('run_benzhi_smoke.sh 必须启用失败即退出');
    if (smokeUsesExternalNetwork(smokeScript)) add('run_benzhi_smoke.sh 不能依赖外部网络，只能访问本机启动的项目');
    if (/\bpipefail\b/.test(smokeScript) && /\bcurl\b[^\n|]*\|\s*grep\s+[^\n]*-q\b/m.test(smokeScript)) {
      add('run_benzhi_smoke.sh 在 pipefail 下不能使用 curl | grep -q；grep 提前退出会使 curl 因 SIGPIPE 随机失败，请先保存响应再断言');
    }
  }

  if (readme) {
    if (usesManagedPolicy) {
      for (const issue of validateReadmeProjectIntroduction(readme, packageOptions).issues) addPolicy(issue);
    }
    if (!/build_benzhi_docker\.sh/i.test(readme) || !/docker\s+run/i.test(readme)) add('BENZHI_README.md 必须包含镜像构建和 docker run 命令');
    if (!/linux\/arm64/i.test(readme) || !/linux\/amd64/i.test(readme)) add('BENZHI_README.md 必须分别记录 linux/arm64 和 linux/amd64 的构建验证命令');
    if (!/go\s+build\s+\.\/\.\.\./i.test(readme) && !bugRepro.hasGoBuildCommand) add('BENZHI_README.md 必须包含 go build ./... 编译命令');
    if (!/go\s+(?:test|run)\b/i.test(readme) && !bugRepro.hasGoCommand) add('BENZHI_README.md 必须包含项目测试或运行命令');
  }

  warnings.push('静态规则通过后，系统还必须分别实际构建 linux/arm64 和 linux/amd64 镜像，并在两个无网络容器中完成题目验证，才可交付');
  return { ok: issues.length === 0, issues, policyIssues, warnings, fileCount: entries.length, rootPrefix, frontendDir };
}

export function validateGoPackageAgainstBaseline(rawEntries, baselineEntries, options = {}) {
  const current = validateGoPackage(rawEntries, options);
  const baseline = validateGoPackage(baselineEntries, options);
  const baselineIssues = new Set(baseline.issues);
  const enforcedPolicyIssues = new Set(current.policyIssues || []);
  const introducedIssues = current.issues.filter((issue) => enforcedPolicyIssues.has(issue) || !baselineIssues.has(issue));
  const grandfatheredIssues = current.issues.filter((issue) => !enforcedPolicyIssues.has(issue) && baselineIssues.has(issue));
  return {
    ...current,
    ok: introducedIssues.length === 0,
    issues: introducedIssues,
    currentIssues: current.issues,
    introducedIssues,
    grandfatheredIssues,
    baseline: {
      ok: baseline.ok,
      issues: baseline.issues,
    },
  };
}

export function scanAnswerLeakage(rawEntries, { needles = [] } = {}) {
  const { entries } = normalizePackageEntries(rawEntries);
  const issues = [];
  const scannedSensitiveFiles = [];
  for (const entry of entries) {
    const sensitive = ANSWER_ARTIFACT_PATH_PATTERN.test(entry.path)
      || /(?:^|\/)(?:vendor|testdata|docs?|\.github)(?:\/|$)|(?:^|\/)(?:CHANGELOG|HISTORY|ISSUES?)(?:\.[^/]*)?$/i.test(entry.path);
    if (sensitive) scannedSensitiveFiles.push(entry.path);
    if (ANSWER_ARTIFACT_PATH_PATTERN.test(entry.path)) issues.push(`项目包含疑似答案或隐藏验收路径：${entry.path}`);
    if (MODEL_INSTRUCTION_PATH_PATTERN.test(entry.path)) issues.push(`项目包含会影响测试模型的指令文件：${entry.path}`);
    const text = asText(entry.content);
    if (ANSWER_MARKER_PATTERN.test(text)) issues.push(`项目文件泄露流水线或答案标记：${entry.path}`);
    for (const needle of needles.map(String).map((value) => value.trim()).filter((value) => value.length >= 16)) {
      if (text.includes(needle)) issues.push(`项目文件包含未公开的完整根因文本：${entry.path}`);
    }
  }
  return { ok: issues.length === 0, issues: [...new Set(issues)], scannedFiles: entries.length, scannedSensitiveFiles };
}
