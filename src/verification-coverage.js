import crypto from 'node:crypto';
import { verificationCommandsSha256 } from './verification-proof.js';
import { verificationTestNamesFromCommand } from './model-verification.js';
import { isGenericPreservationRequirement } from './verification-coverage-checklist.js';

export const VERIFICATION_COVERAGE_POLICY_VERSION = 2;

const TARGET_BEHAVIOR = 'target_behavior';
const PROCESS_CONSTRAINT = 'process_constraint';
const ALLOWED_SOURCES = new Set(['user_query', 'success_criteria', 'both']);
const ALLOWED_CATEGORIES = new Set([TARGET_BEHAVIOR, PROCESS_CONSTRAINT]);
const ALLOWED_STATUSES = new Set(['covered', 'not_covered', 'not_applicable']);
const ALLOWED_CONTRACT_LEVELS = new Set(['hard', 'supplemental']);

// Coverage review must establish the behavior promised by the task, but it
// must not turn finite representative tests into an impossible enumeration of
// every permutation, field combination, or normal-path variant. Those are
// useful review notes; the deterministic target test and the full-suite gate
// remain the actual acceptance evidence.
function isSupplementalCoverageRequirement(item = {}, userQuery = '') {
  const requirementText = `${normalizedText(item.requirement)} ${normalizedText(item.message)}`;
  // success_criteria can clarify an observable behavior already present in
  // user_query, but it can never create a new hard coverage requirement.
  if (item?.source === 'success_criteria') return true;
  if (isGenericPreservationRequirement(requirementText)) return true;
  // New reports carry this discriminator explicitly. Keep the text heuristic
  // only for reports produced before the discriminator was introduced.
  if (ALLOWED_CONTRACT_LEVELS.has(item?.contract_level)) return item.contract_level === 'supplemental';
  const text = `${normalizedText(item.requirement)} ${normalizedText(item.evidence)}`;
  const query = normalizedText(userQuery);
  const combinatorialExpansion = /(?:每|所有).{0,24}(?:排列|重排|目录字段|母管字段|字段组合)|(?:every|each).{0,60}(?:permutation|reorder(?:ed)?(?:\s+boundary)?\s+input|catalog\s+field|mother\s+field|field\s+combination)/i.test(text);
  const extraPrecondition = /未(?:预留|分配)窗口|before\s+(?:a\s+)?window\s+is\s+reserved/i.test(text)
    && !/未(?:预留|分配)窗口|窗口(?:预留|分配).{0,8}(?:之前|以前|前)|before\s+(?:a\s+)?window\s+is\s+reserved/i.test(query);
  const extraNormalFlow = /正常(?:完整|完整的)?流程|完整正常流程|normal(?:-path)?\s+(?:complete|flow)/i.test(text)
    && !/正常(?:完整|完整的)?流程|完整正常流程|normal(?:-path)?\s+(?:complete|flow)/i.test(query);
  return combinatorialExpansion || extraPrecondition || extraNormalFlow;
}

function isRepresentativeCoverageReviewNote(item = {}, supplementalRequirements = []) {
  if (isGenericPreservationRequirement(`${normalizedText(item?.message || item)} ${normalizedText(item?.requirement)}`)) return true;
  if (item?.contract_level === 'supplemental') return true;
  if (item?.contract_level === 'hard') return false;
  const text = normalizedText(item?.message || item);
  const combinatorialExpansion = /(?:每|所有).{0,24}(?:排列|重排|目录字段|母管字段|字段组合)|(?:every|each).{0,60}(?:permutation|reorder(?:ed)?(?:\s+boundary)?\s+input|catalog\s+field|mother\s+field|field\s+combination)/i.test(text);
  if (combinatorialExpansion) return true;
  return supplementalRequirements.some((requirement) => {
    const requirementText = normalizedText(requirement.requirement);
    return (/(?:未(?:预留|分配)窗口|before\s+(?:a\s+)?window\s+(?:is\s+reserved|reservation))/i.test(text)
        && /(?:未(?:预留|分配)窗口|before\s+(?:a\s+)?window\s+is\s+reserved)/i.test(requirementText))
      || (/(?:正常(?:完整|完整的)?流程|完整正常流程|normal(?:-path)?\s+(?:complete|flow)|retained normal path)/i.test(text)
        && /(?:正常(?:完整|完整的)?流程|完整正常流程|normal(?:-path)?\s+(?:complete|flow))/i.test(requirementText));
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedText(value) {
  return String(value || '').trim();
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function normalizeTestSources(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => ({
      path: String(entry?.path || '').replaceAll('\\', '/').replace(/^\.\//, '').trim(),
      content: String(entry?.content || ''),
    }))
    .filter((entry) => entry.path && entry.content)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function selectedSources(options = {}) {
  return options.modelTests || options.testSources || options.goldTests || [];
}

function verificationTestNamesFromCommands(verifyCmds = []) {
  return [...new Set((Array.isArray(verifyCmds) ? verifyCmds : [])
    .flatMap((command) => verificationTestNamesFromCommand(command)))].sort();
}

function reportedTestNames(report = {}) {
  return Array.isArray(report?.test_names)
    ? [...new Set(report.test_names.map(String))].sort()
    : report?.test_name ? [String(report.test_name)] : [];
}

function expectedCoverageTestNames(report, verifyCmds) {
  const commandNames = verificationTestNamesFromCommands(verifyCmds);
  return commandNames.length ? commandNames : reportedTestNames(report);
}

export function verificationCoverageHashes({ userQuery, successCriteria, verifyCmds, modelTests, testSources, goldTests } = {}) {
  const tests = normalizeTestSources(modelTests || testSources || goldTests);
  const testManifest = tests.map((entry) => ({ path: entry.path, sha256: sha256(entry.content) }));
  return {
    user_query_sha256: sha256(`${normalizedText(userQuery)}\n`),
    success_criteria_sha256: sha256(`${normalizedText(successCriteria)}\n`),
    verify_cmds_sha256: verificationCommandsSha256(Array.isArray(verifyCmds) ? verifyCmds : []),
    model_tests_sha256: sha256(canonicalJson(testManifest)),
  };
}

function legacyCoverageHashes(input = {}) {
  const { model_tests_sha256: gold_tests_sha256, ...rest } = verificationCoverageHashes(input);
  return { ...rest, gold_tests_sha256 };
}

export function verificationCoverageReportIssues(report = {}, { verifyCmds = [], modelTests, testSources, goldTests, userQuery = '' } = {}) {
  const issues = [];
  const tests = normalizeTestSources(modelTests || testSources || goldTests);
  const commandNames = verificationTestNamesFromCommands(verifyCmds);
  const testPaths = new Set(tests.map((entry) => entry.path));
  const testSource = tests.map((entry) => entry.content).join('\n');

  if (!report || typeof report !== 'object' || Array.isArray(report)) return ['题面覆盖报告必须是 JSON 对象'];
  const reportedNames = reportedTestNames(report);
  const testNames = commandNames.length ? commandNames : reportedNames;
  if (!reportedNames.length) {
    issues.push('题面覆盖报告必须列出用于语义复核的公开测试名称');
  } else if (commandNames.length && JSON.stringify(reportedNames) !== JSON.stringify(commandNames)) {
    issues.push('题面覆盖报告的目标测试名称集合与 verify_cmds 不一致');
  }
  for (const testName of testNames) {
    if (!new RegExp(`\\bfunc\\s+${testName}\\s*\\(`).test(testSource)) {
      issues.push(`verify_cmds 指向的目标测试函数不在公开模型测试源码中：${testName}`);
    }
  }
  const reportedFiles = Array.isArray(report.test_files) ? [...report.test_files].map(String).sort() : [];
  if (JSON.stringify(reportedFiles) !== JSON.stringify([...testPaths].sort())) issues.push('题面覆盖报告的测试文件集合与公开模型测试不一致');

  const requirements = Array.isArray(report.requirements) ? report.requirements : [];
  const supplementalRequirements = requirements.filter((item) => isSupplementalCoverageRequirement(item, userQuery));
  if (!requirements.length) issues.push('题面覆盖报告没有逐项拆解 user_query 与 success_criteria');
  let targetCount = 0;
  for (const [index, item] of requirements.entries()) {
    const label = `覆盖项 #${index + 1}`;
    if (!ALLOWED_SOURCES.has(item?.source)) issues.push(`${label} 的 source 不合法`);
    if (!ALLOWED_CATEGORIES.has(item?.category)) issues.push(`${label} 的 category 不合法`);
    if (!ALLOWED_STATUSES.has(item?.status)) issues.push(`${label} 的 status 不合法`);
    if (item?.contract_level !== undefined && !ALLOWED_CONTRACT_LEVELS.has(item.contract_level)) {
      issues.push(`${label} 的 contract_level 不合法`);
    }
    if (normalizedText(item?.requirement).length < 8) issues.push(`${label} 缺少明确验收要求`);
    if (item?.category === TARGET_BEHAVIOR) {
      targetCount += 1;
      if (item.status !== 'covered' && !isSupplementalCoverageRequirement(item, userQuery)) {
        issues.push(`${label} 的 Bug 行为未由 verify_cmds 目标测试完整覆盖`);
      }
      const evidence = normalizedText(item?.evidence);
      const citesTestSource = [...testPaths].some((filename) => evidence.includes(filename));
      const contextualSingleFileEvidence = testPaths.size === 1
        && /(?:same|those|across|该|同一|上述).{0,120}(?:subtest|test|断言|assert|check)|(?:subtest|test).{0,80}(?:断言|assert|check)/i.test(evidence);
      if (evidence.length < 12 || (!citesTestSource && !contextualSingleFileEvidence)) {
        if (isSupplementalCoverageRequirement(item, userQuery)) continue;
        issues.push(`${label} 缺少指向实际公开模型测试文件和断言的证据`);
      }
    } else if (item?.category === PROCESS_CONSTRAINT) {
      // Process constraints such as running the full suite are enforced by
      // the pipeline stages themselves. The coverage reviewer is read-only
      // and must not turn an unavailable sandbox command into a target failure.
      continue;
    }
  }
  if (!targetCount) issues.push('题面覆盖报告没有识别任何 Bug 可观察行为');
  if (Array.isArray(report.issues) && report.issues.length) {
    // New reports label reviewer issues. Keep unlabeled issues strict for
    // backward compatibility, but never promote a process-only issue to a
    // coverage failure.
    issues.push(...report.issues
      .filter((item) => item?.category !== PROCESS_CONSTRAINT
        && !isRepresentativeCoverageReviewNote(item, supplementalRequirements))
      .map((item) => normalizedText(item?.message || item))
      .filter(Boolean));
  }
  return [...new Set(issues)];
}

export function createVerificationCoverageAttestation({
  userQuery,
  successCriteria,
  verifyCmds,
  modelTests,
  testSources,
  goldTests,
  report,
  reviewerSessionId = '',
  reviewedAt = new Date().toISOString(),
} = {}) {
  const tests = modelTests || testSources || goldTests;
  const issues = verificationCoverageReportIssues(report, { verifyCmds, modelTests: tests, userQuery });
  if (issues.length) throw new Error(`verify_cmds 未完整覆盖题面：${issues.join('；')}`);
  const hashes = verificationCoverageHashes({ userQuery, successCriteria, verifyCmds, modelTests: tests });
  const targetRequirementCount = report.requirements.filter((item) => item.category === TARGET_BEHAVIOR).length;
  const testNames = expectedCoverageTestNames(report, verifyCmds);
  return {
    policy_version: VERIFICATION_COVERAGE_POLICY_VERSION,
    approved: true,
    reviewer: 'codex-read-only',
    reviewer_session_id: normalizedText(reviewerSessionId),
    reviewed_at: reviewedAt,
    test_names: testNames,
    target_requirement_count: targetRequirementCount,
    report_sha256: sha256(canonicalJson(report)),
    ...hashes,
  };
}

export function verificationCoverageAttestationIssues(metadata = {}, options = {}) {
  const policyVersion = Number(metadata.verification_coverage_policy_version || 0);
  if (policyVersion < 1) return [];
  const issues = [];
  const attestation = metadata.verification_coverage;
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) return ['缺少 verify_cmds 题面完整覆盖证明'];
  if (Number(attestation.policy_version || 0) !== policyVersion) issues.push('题面覆盖证明版本不正确');
  if (attestation.approved !== true || attestation.reviewer !== 'codex-read-only') issues.push('题面覆盖证明未由系统只读复核通过');
  const report = options.report || null;
  if (!report) return [...issues, '缺少隐藏 grader/verification-coverage.json 覆盖报告'];

  const verifyCmds = Array.isArray(metadata.verify_cmds) ? metadata.verify_cmds : [];
  const tests = selectedSources(options);
  issues.push(...verificationCoverageReportIssues(report, { verifyCmds, modelTests: tests, userQuery: metadata.user_query }));
  const hashInput = {
    userQuery: metadata.user_query,
    successCriteria: metadata.success_criteria,
    verifyCmds,
    modelTests: tests,
  };
  const hashes = policyVersion >= VERIFICATION_COVERAGE_POLICY_VERSION
    ? verificationCoverageHashes(hashInput)
    : legacyCoverageHashes(hashInput);
  for (const [field, expected] of Object.entries(hashes)) {
    if (attestation[field] !== expected) issues.push(`题面覆盖证明的 ${field} 与当前交付内容不一致`);
  }
  if (attestation.report_sha256 !== sha256(canonicalJson(report))) issues.push('题面覆盖报告哈希与公开证明不一致');
  if (policyVersion >= VERIFICATION_COVERAGE_POLICY_VERSION) {
    const expectedNames = expectedCoverageTestNames(report, verifyCmds);
    if (JSON.stringify(attestation.test_names) !== JSON.stringify(expectedNames)) issues.push('题面覆盖证明的目标测试名称集合与报告不一致');
  } else if (attestation.test_name !== report.test_name) {
    issues.push('题面覆盖证明的目标测试名称与报告不一致');
  }
  const targetCount = Array.isArray(report.requirements)
    ? report.requirements.filter((item) => item.category === TARGET_BEHAVIOR).length
    : 0;
  if (Number(attestation.target_requirement_count) !== targetCount) issues.push('题面覆盖证明的行为要求数量与报告不一致');
  return [...new Set(issues)];
}

export function assertVerificationCoverage(metadata = {}, options = {}) {
  const issues = verificationCoverageAttestationIssues(metadata, options);
  if (issues.length) {
    const bugId = String(metadata.bug_id || metadata.sample_id || '未知任务');
    throw new Error(`${bugId} 禁止 Excel 导出：${issues.join('；')}`);
  }
  return metadata.verification_coverage || null;
}

export const testNameFromCommand = (command) => verificationTestNamesFromCommand(command)[0] || '';
