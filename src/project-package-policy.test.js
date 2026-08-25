import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isBugReproPath,
  normalizePackageExpectedFailureCommands,
  projectPackageRuleOptions,
  validateProjectPackagePlan,
  validateReadmeProjectIntroduction,
} from './project-package-policy.js';

const cliSummary = '基于 Go 实现的停车场管理 CLI 项目，一款命令行工具，完成车位录入、车辆进出登记与费用核算。';
const webSummary = '基于 Go 实现的外卖订单管理 Web 项目，一款后端服务，处理订单创建、状态流转与商家数据管理。';
const technicalSummary = '基于 Go 实现的DNSSEC轮换 Web 项目，一款后端服务，协调 HSM 槽位与 API 发布租约。';

test('current package policy accepts the required CLI and Web introduction forms', () => {
  assert.equal(validateProjectPackagePlan({
    project_package_policy_version: 2,
    project_type: 'cli',
    project_summary: cliSummary,
  }).ok, true);
  assert.equal(validateProjectPackagePlan({
    project_package_policy_version: 2,
    project_type: 'web',
    project_summary: webSummary,
  }).ok, true);
  assert.equal(validateProjectPackagePlan({
    project_package_policy_version: 2,
    project_type: 'web',
    project_summary: technicalSummary,
  }).ok, true);
});

test('current package policy rejects English drafting leakage and extra sentences', () => {
  const leaked = '基于 Go 实现的 Web 项目：PotatoEye 面向种薯繁育场，管理催芽室联检闭环。彰化? no! wait JSON final invalid? We should输出 Web 项目，一款后端服务，?。';
  const leakedResult = validateProjectPackagePlan({
    project_package_policy_version: 2,
    project_type: 'web',
    project_summary: leaked,
  });
  assert.equal(leakedResult.ok, false);
  assert.ok(leakedResult.issues.some((issue) => issue.includes('严格使用')));
  assert.ok(leakedResult.issues.some((issue) => issue.includes('英文叙述')));

  const secondSentence = `${webSummary}该项目还会生成运营报表。`;
  assert.equal(validateProjectPackagePlan({
    project_package_policy_version: 2,
    project_type: 'web',
    project_summary: secondSentence,
  }).ok, false);
});

test('current package policy rejects English prose inside an otherwise valid template', () => {
  const result = validateProjectPackagePlan({
    project_package_policy_version: 2,
    project_type: 'web',
    project_summary: '基于 Go 实现的外卖订单管理 Web 项目，一款后端服务，track order state and notify users。',
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('track')));

  const unknownAcronym = validateProjectPackagePlan({
    project_package_policy_version: 2,
    project_type: 'web',
    project_summary: '基于 Go 实现的外卖订单管理 Web 项目，一款后端服务，使用 ACME 平台处理订单创建与状态流转。',
  });
  assert.equal(unknownAcronym.ok, false);
  assert.ok(unknownAcronym.issues.some((issue) => issue.includes('ACME')));
});

test('current package policy requires substantive Chinese domain and capability text', () => {
  const weakDomain = validateProjectPackagePlan({
    project_package_policy_version: 2,
    project_type: 'web',
    project_summary: '基于 Go 实现的API管 Web 项目，一款后端服务，处理订单创建、状态流转与商家数据管理。',
  });
  assert.equal(weakDomain.ok, false);
  assert.ok(weakDomain.issues.some((issue) => issue.includes('至少需要包含 2 个汉字')));

  const weakCapability = validateProjectPackagePlan({
    project_package_policy_version: 2,
    project_type: 'web',
    project_summary: '基于 Go 实现的接口管理 Web 项目，一款后端服务，管理 API 请求。',
  });
  assert.equal(weakCapability.ok, false);
  assert.ok(weakCapability.issues.some((issue) => issue.includes('至少需要包含 6 个汉字')));
});

test('current package policy keeps project type and summary aligned', () => {
  const mismatch = validateProjectPackagePlan({
    project_package_policy_version: 2,
    project_type: 'cli',
    project_summary: webSummary,
  });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.issues.some((issue) => issue.includes('CLI 项目简介')));

  const frontendCli = validateProjectPackagePlan({
    project_package_policy_version: 2,
    project_type: 'cli',
    project_summary: cliSummary,
    frontend_required: true,
  });
  assert.ok(frontendCli.issues.some((issue) => issue.includes('必须声明为 web')));
});

test('README introduction must be the exact first line from project metadata', () => {
  const valid = validateReadmeProjectIntroduction(`${webSummary}\n\n# Project\n`, {
    projectPackagePolicyVersion: 2,
    projectType: 'web',
    projectSummary: webSummary,
  });
  assert.equal(valid.ok, true);

  const invalid = validateReadmeProjectIntroduction(`# Project\n\n${webSummary}\n`, {
    projectPackagePolicyVersion: 2,
    projectType: 'web',
    projectSummary: webSummary,
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.includes('第一行')));

  const leaked = '基于 Go 实现的订单 Web 项目，一款后端服务，track state and retry requests。';
  const leakedReadme = validateReadmeProjectIntroduction(`${leaked}\n\n# Project\n`, {
    projectPackagePolicyVersion: 2,
    projectType: 'web',
    projectSummary: leaked,
  });
  assert.equal(leakedReadme.ok, false);
  assert.ok(leakedReadme.issues.some((issue) => issue.includes('英文叙述')));
});

test('BUG_REPRO detection covers nested and case-insensitive paths', () => {
  assert.equal(isBugReproPath('BUG_REPRO.md'), true);
  assert.equal(isBugReproPath('docs/bug_repro.MD'), true);
  assert.equal(isBugReproPath('docs/repro.md'), false);
});

test('expected failure commands are normalized from diagnosis task metadata', () => {
  assert.deepEqual(normalizePackageExpectedFailureCommands([
    '$ go test ./...',
    'go test ./...',
    'go test ./... $(touch /tmp/unsafe)',
    'rm -rf /',
  ]), ['go test ./...']);
  assert.deepEqual(projectPackageRuleOptions({
    project_package_policy_version: 2,
    task_type: 'diagnosis',
    verify_cmds: ['go test ./...'],
  }).expectedFailureCommands, ['go test ./...']);
});

test('legacy package policy does not require project metadata', () => {
  assert.equal(validateProjectPackagePlan({ project_package_policy_version: 1 }).ok, true);
});
