import crypto from 'node:crypto';
import path from 'node:path';
import { CONCURRENCY_VERIFY_MIN_COUNT } from './verification-proof.js';

export const MODEL_TEST_PREFIX = 'TestModel_';
export const MODEL_VERIFICATION_POLICY_VERSION = 1;

function sha256(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

function normalizeRelativeTestPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || !normalized.endsWith('_test.go')) {
    throw new Error(`模型回归测试路径不安全：${value}`);
  }
  return normalized;
}

// The model may return a placeholder package (most commonly ".") even when
// the test file lives in a nested Go package.  The file location is the only
// unambiguous source of truth for an independently authored test.
export function verificationTestPackage(testFile) {
  const filename = normalizeRelativeTestPath(testFile);
  const directory = path.posix.dirname(filename);
  return directory === '.' ? '.' : `./${directory}`;
}

export function goTestNames(source, { prefix = '' } = {}) {
  const names = [];
  const pattern = /(?:^|\n)\s*func\s+(Test[A-Za-z0-9_]+)\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s+\*testing\.T\s*\)/g;
  for (const match of String(source || '').matchAll(pattern)) {
    if (!prefix || match[1].startsWith(prefix)) names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

export function isTableDrivenGoTest(source) {
  const value = String(source || '');
  const hasCaseLoop = /\bfor\s+[^{}\n]*:=\s*range\s+(?:[A-Za-z_][A-Za-z0-9_]*|\[)/.test(value);
  return hasCaseLoop && /\bt\.Run\s*\(/.test(value);
}

export function verificationTestNamesFromCommand(command) {
  const match = String(command || '').match(/(?:^|\s)-run(?:=|\s+)(?:['"])([^'"]+)(?:['"])(?:\s|$)/)
    || String(command || '').match(/(?:^|\s)-run(?:=|\s+)([^\s]+)(?:\s|$)/);
  return match ? [...new Set(match[1].match(/\bTest[A-Za-z0-9_]+\b/g) || [])].sort() : [];
}

export function buildModelVerificationPlan(testSources = [], { concurrency = false } = {}) {
  const normalized = (Array.isArray(testSources) ? testSources : []).map((entry) => {
    const filename = normalizeRelativeTestPath(entry?.path);
    const content = String(entry?.content || '');
    const testNames = goTestNames(content, { prefix: MODEL_TEST_PREFIX });
    return { path: filename, content, testNames };
  }).filter((entry) => entry.testNames.length);
  if (!normalized.length) {
    throw new Error(`bugfix 必须在新增或修改的 Go 回归测试文件中定义至少一个 ${MODEL_TEST_PREFIX} 测试`);
  }

  const testNames = [...new Set(normalized.flatMap((entry) => entry.testNames))].sort();
  const packages = [...new Set(normalized.map((entry) => verificationTestPackage(entry.path)))].sort();
  const runExpression = testNames.length === 1 ? `^${testNames[0]}$` : `^(${testNames.join('|')})$`;
  const repeatCount = concurrency ? CONCURRENCY_VERIFY_MIN_COUNT : 1;
  const command = `go test ${concurrency ? '-race ' : ''}${packages.join(' ')} -run '${runExpression}' -count=${repeatCount} -v`;
  return {
    policy_version: MODEL_VERIFICATION_POLICY_VERSION,
    concurrency_verification: Boolean(concurrency),
    verification_repeat_count: repeatCount,
    verify_cmds: [command],
    verification_test_overlay: 'repository-tests',
    verification_test_files: normalized.map((entry) => entry.path).sort(),
    verification_test_names: testNames,
    verification_test_manifest: normalized.map((entry) => ({ path: entry.path, sha256: sha256(entry.content) })).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function modelVerificationPlanIssues(plan = {}, testSources = [], {
  concurrency = Boolean(plan?.concurrency_verification),
} = {}) {
  const issues = [];
  const sources = new Map();
  for (const entry of Array.isArray(testSources) ? testSources : []) {
    try {
      const filename = normalizeRelativeTestPath(entry?.path);
      sources.set(filename, String(entry?.content || ''));
    } catch (error) {
      issues.push(error.message);
    }
  }
  const files = Array.isArray(plan.verification_test_files) ? plan.verification_test_files.map(String).sort() : [];
  const names = Array.isArray(plan.verification_test_names) ? plan.verification_test_names.map(String).sort() : [];
  const command = Array.isArray(plan.verify_cmds) ? String(plan.verify_cmds[0] || '') : '';
  const commandNames = verificationTestNamesFromCommand(command);
  if (Number(plan.model_verification_policy_version || plan.policy_version || 0) !== MODEL_VERIFICATION_POLICY_VERSION) {
    issues.push('模型回归验证计划版本不正确');
  }
  if (plan.verification_test_overlay !== 'repository-tests') issues.push('bugfix 验证测试必须来自提交仓库，verification_test_overlay 必须为 repository-tests');
  if (!files.length) issues.push('缺少公开模型回归测试文件清单');
  if (!names.length) issues.push('缺少公开模型回归测试名称清单');
  if (JSON.stringify(commandNames) !== JSON.stringify(names)) issues.push('verify_cmds 中的测试名称与模型回归测试清单不一致');
  if (JSON.stringify([...sources.keys()].sort()) !== JSON.stringify(files)) issues.push('模型回归测试源码集合与文件清单不一致');
  const expectedPackages = [...new Set(files.map((filename) => verificationTestPackage(filename)))].sort();
  const commandPackages = command.match(/^go\s+test\s+(?:-race\s+)?(.+?)\s+-run(?:=|\s)/i)?.[1]?.trim() || '';
  if (expectedPackages.length && commandPackages !== expectedPackages.join(' ')) {
    issues.push(`verify_cmds 的 Go 包与测试文件路径不一致：应为 ${expectedPackages.join(' ')}`);
  }
  if (concurrency) {
    if (!/(?:^|\s)-race(?:\s|$)/.test(command)) issues.push('并发模型验证命令必须使用 -race');
    const repeatCount = Number(command.match(/(?:^|\s)-count(?:=|\s+)(\d+)(?:\s|$)/)?.[1] || 0);
    if (repeatCount < CONCURRENCY_VERIFY_MIN_COUNT) {
      issues.push(`并发模型验证命令的 -count=N 必须不小于 ${CONCURRENCY_VERIFY_MIN_COUNT}`);
    }
  }

  const manifest = Array.isArray(plan.verification_test_manifest) ? [...plan.verification_test_manifest]
    .map((entry) => ({ path: String(entry?.path || ''), sha256: String(entry?.sha256 || '') }))
    .sort((a, b) => a.path.localeCompare(b.path)) : [];
  for (const filename of files) {
    const content = sources.get(filename);
    if (content === undefined) continue;
    const sourceNames = goTestNames(content, { prefix: MODEL_TEST_PREFIX });
    for (const name of names) {
      if (commandNames.includes(name) && ![...sources.values()].some((source) => goTestNames(source).includes(name))) {
        issues.push(`verify_cmds 指向的测试函数不在公开模型测试源码中：${name}`);
      }
    }
    const expected = manifest.find((entry) => entry.path === filename)?.sha256;
    if (!expected || expected !== sha256(content)) issues.push(`公开模型测试文件哈希不一致：${filename}`);
    if (!sourceNames.length) issues.push(`公开模型测试文件未定义 ${MODEL_TEST_PREFIX} 测试：${filename}`);
  }
  return [...new Set(issues)];
}

export function assertModelVerificationPlan(plan = {}, testSources = []) {
  const issues = modelVerificationPlanIssues(plan, testSources);
  if (issues.length) throw new Error(`公开模型回归验证计划无效：${issues.join('；')}`);
  return plan;
}

export { normalizeRelativeTestPath };
