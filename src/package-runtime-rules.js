import { inspectBugRepro, normalizePackageEntries } from './package-rules.js';
import {
  MANAGED_PROJECT_PACKAGE_POLICY_VERSION,
  projectPackageRuleOptions,
} from './project-package-policy.js';

export const CONTAINER_SHELL_ARGS = Object.freeze(['bash', '-c']);

function shellComment(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function asText(content) {
  if (typeof content === 'string') return content;
  if (content instanceof Uint8Array) return new TextDecoder().decode(content);
  return String(content || '');
}

/**
 * A smoke script may deliberately exercise a pre-built service binary instead
 * of invoking `go run`.  Resolve only binaries whose conventional cmd/<name>
 * package is present so generic projects keep their existing smoke behavior.
 */
export function findRuntimeSmokeBinary(entryMap, smokePath = 'run_benzhi_smoke.sh') {
  const smoke = asText(entryMap.get(smokePath)?.content);
  const resolve = (name, outputPath) => {
    const packagePath = `cmd/${name}/main.go`;
    if (entryMap.has(packagePath)) {
      return { name, packagePath: `./cmd/${name}`, outputPath };
    }
    return null;
  };

  // Prefer a binary explicitly referenced beside the script. This must run
  // before bin/ detection because comments may also mention /usr/local/bin.
  for (const match of smoke.matchAll(/\$\{(?:ROOT_DIR|PWD)\}\/([A-Za-z0-9_.-]+)/g)) {
    const found = resolve(match[1], `./${match[1]}`);
    if (found) return found;
  }
  const projectBinPattern = /(?:\$\{(?:ROOT_DIR|PWD)\}\/|\.\/|(?:^|[\s"'=]))bin\/([A-Za-z0-9_.-]+)/gm;
  for (const match of smoke.matchAll(projectBinPattern)) {
    const found = resolve(match[1], `./bin/${match[1]}`);
    if (found) return found;
  }
  return null;
}

export function createContainerVerificationPlan(rawEntries, frontendDir = '', options = {}) {
  const { entries } = normalizePackageEntries(rawEntries);
  const entryMap = new Map(entries.map((entry) => [entry.path, entry]));
  const packageOptions = projectPackageRuleOptions(options);
  const usesManagedPolicy = packageOptions.projectPackagePolicyVersion >= MANAGED_PROJECT_PACKAGE_POLICY_VERSION;
  const expectedFailureCommands = usesManagedPolicy
    ? packageOptions.expectedFailureCommands
    : inspectBugRepro(entryMap.get('BUG_REPRO.md')?.content).commands;
  const readme = asText(entryMap.get('BENZHI_README.md')?.content);
  const vendorMode = /(?:-mod=vendor|GOFLAGS\s*=\s*[^\n]*-mod=vendor)/i.test(readme) && /vendor/i.test(readme);
  const runtimeSmokeFile = entryMap.has('run_benzhi_smoke.sh') ? 'run_benzhi_smoke.sh' : '';
  const runtimeSmokeBinary = runtimeSmokeFile ? findRuntimeSmokeBinary(entryMap, runtimeSmokeFile) : null;
  const step = (label, command) => [`echo "[verify] ${label}"`, command];
  const lines = [
    'set -e',
    'export GOTOOLCHAIN=local',
    ...step('go version', 'go version'),
  ];
  if (frontendDir) lines.push(...step('node version', 'node --version'));
  if (!vendorMode) lines.push(...step('offline module cache', 'GOPROXY=off go mod download'));

  if (expectedFailureCommands.length) {
    for (const command of expectedFailureCommands) {
      const label = shellComment(command).replaceAll('"', '\\"');
      lines.push(
        `echo "Running expected-failure reproduction: ${label}"`,
        'set +e',
        command,
        'REPRO_STATUS=$?',
        'set -e',
        'if [ "$REPRO_STATUS" -eq 0 ]; then echo "Expected-failure command unexpectedly succeeded" >&2; exit 97; fi',
        'echo "Expected-failure command failed as expected"',
      );
    }
  } else {
    // A Go package may embed frontend output. Build it before loading Go
    // packages so a clean image never fails on missing //go:embed assets.
    if (frontendDir) lines.push(...step('frontend build', `npm --prefix "${frontendDir}" run build`));
    lines.push(...step('go build', 'GOPROXY=off go build ./...'));
    lines.push(...step('go test', 'GOPROXY=off go test ./...'));
    lines.push(...step('go vet', 'GOPROXY=off go vet ./...'));
  }
  if (runtimeSmokeBinary) {
    const buildPrefix = vendorMode ? 'GOFLAGS=-mod=vendor ' : '';
    lines.push(
      ...step('runtime smoke binary', `mkdir -p bin && ${buildPrefix}GOPROXY=off go build -o ${runtimeSmokeBinary.outputPath} ${runtimeSmokeBinary.packagePath}`),
    );
  }
  if (runtimeSmokeFile) lines.push(...step('runtime smoke', `bash ./${runtimeSmokeFile}`));

  return {
    script: `${lines.join('\n')}\n`,
    commands: expectedFailureCommands,
    expectsFailure: expectedFailureCommands.length > 0,
    frontendDir,
    vendorMode,
    runtimeSmokeFile,
    runtimeSmokeBinary,
  };
}
