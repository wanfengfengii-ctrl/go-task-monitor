import { normalizeVerificationResult, VERIFICATION_POLICY_VERSION } from './verification-evidence.js';
import { directPublicVerifyCommandIssues, isConcurrencyVerificationRecord, verificationCommandsSha256 } from './verification-proof.js';
import { normalizeDiagnosisPublicCommand } from './diagnosis-verification.js';

const UNDEFINED_COMMAND_PATTERN = /\bundefined\b/i;

function sameCommands(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && JSON.stringify(left) === JSON.stringify(right);
}

function canonicalVerifyCommands(commands, taskType) {
  if (!Array.isArray(commands)) return commands;
  return commands.map((command) => taskType === 'diagnosis'
    ? normalizeDiagnosisPublicCommand(command)
    : String(command).trim());
}

export function verificationExportMetadataIssues(metadata = {}, { aggregatedVerifyCmds } = {}) {
  const issues = [];
  if (Number(metadata.verification_policy_version || 0) < VERIFICATION_POLICY_VERSION) {
    issues.push(`verification_policy_version 必须大于等于 ${VERIFICATION_POLICY_VERSION}，旧任务没有可核验的独立红绿证明`);
  }

  const taskType = String(metadata.task_type || '');
  const concurrency = isConcurrencyVerificationRecord(metadata);
  const rawVerifyCmds = metadata.verify_cmds;
  const verifyCmds = canonicalVerifyCommands(rawVerifyCmds, taskType);
  if (!Array.isArray(rawVerifyCmds) || !rawVerifyCmds.length || rawVerifyCmds.some((command) => typeof command !== 'string' || !command.trim())) {
    issues.push('public.json.verify_cmds 必须是非空原始命令数组');
  } else if (verifyCmds.some((command) => UNDEFINED_COMMAND_PATTERN.test(command))) {
    issues.push('verify_cmds 包含完整单词 undefined');
  }

  const canonicalAggregated = aggregatedVerifyCmds === undefined
    ? undefined
    : canonicalVerifyCommands(aggregatedVerifyCmds, taskType);
  if (canonicalAggregated !== undefined && !sameCommands(canonicalAggregated, verifyCmds)) {
    issues.push('任务聚合后的 verify_cmds 与 public.json 原始命令数组不一致');
  }

  if (Array.isArray(verifyCmds)) issues.push(...directPublicVerifyCommandIssues(verifyCmds, taskType, { concurrency }));
  if (concurrency) {
    const narrative = `${metadata.success_criteria || ''}\n${metadata.gold_root_cause || ''}`;
    if (!/确定性(?:复现|验证)(?:策略|替代方案)|同步屏障|起跑屏障|受控交错|固定并发轮次|固定资源裁定顺序/u.test(narrative)) {
      issues.push('并发题的 success_criteria 或 gold_root_cause 必须说明确定性复现策略，例如同步屏障、受控交错或固定资源裁定顺序');
    }
    if (!/go\s+test\b[^\n。；]*-race\b[^\n。；]*-count(?:=|\s+)\d+/i.test(narrative)) {
      issues.push('并发题的 success_criteria 或 gold_root_cause 必须明确记录 go test -race -count=N 稳定性下限');
    }
  }
  if (Number(metadata.verification_policy_version || 0) >= VERIFICATION_POLICY_VERSION) {
    const overlay = String(metadata.verification_test_overlay || 'none');
    const testFiles = Array.isArray(metadata.verification_test_files)
      ? metadata.verification_test_files.map((filename) => String(filename || '').trim()).filter(Boolean)
      : [];
    if (['gold-tests', 'test-model-fix-tests', 'pending-model-tests'].includes(overlay)) {
      issues.push('V5 验证测试不能只存在于 grader 覆盖层，必须来自提交仓库中的 verification_test_files');
    } else if (overlay === 'repository-tests' && !testFiles.length) {
      issues.push('repository-tests 必须声明至少一个 verification_test_files');
    } else if (overlay === 'private-fixture') {
      if (taskType !== 'diagnosis') issues.push('只有 diagnosis 可以使用外置 private-fixture');
      if (testFiles.length !== 1) issues.push('diagnosis private-fixture 必须声明一个 verification_test_files');
      if (!/^[a-f0-9]{64}$/i.test(String(metadata.verification_fixture_sha256 || ''))) {
        issues.push('diagnosis private-fixture 必须声明有效的 verification_fixture_sha256');
      }
      if (metadata.verification_fixture_materialized === true || metadata.verification_fixture_published === true) {
        issues.push('diagnosis 外置验证测试禁止写入工作区或 Git 分支');
      }
    } else if (testFiles.length && overlay !== 'repository-tests') {
      issues.push('V5 含 verification_test_files 的任务必须使用 verification_test_overlay=repository-tests');
    }
    for (const filename of testFiles) {
      if (filename.startsWith('/') || filename.split(/[\\/]/).includes('..') || !filename.endsWith('_test.go')) {
        issues.push(`verification_test_files 路径不安全：${filename}`);
      }
    }
  }
  if (taskType === 'diagnosis' && Number(metadata.diagnosis_workspace_policy_version || 0) >= 1
    && metadata.diagnosis_workspace_unchanged !== true) {
    issues.push('diagnosis 必须通过工作区零修改校验');
  }
  const phases = taskType === 'bugfix'
    ? ['pre_fix', 'post_fix']
    : taskType === 'diagnosis'
      ? ['pre_fix']
      : [];
  if (!phases.length) issues.push('task_type 必须是 bugfix 或 diagnosis');

  let verifyResult = null;
  try {
    verifyResult = normalizeVerificationResult(metadata.verify_result, {
      taskType,
      mainSessionId: metadata.test_model_fix_session_id,
    });
  } catch (error) {
    issues.push(error.message);
  }

  const verifyCmdsSha256 = Array.isArray(verifyCmds) ? verificationCommandsSha256(verifyCmds) : '';
  const rawVerifyCmdsSha256 = Array.isArray(rawVerifyCmds) ? verificationCommandsSha256(rawVerifyCmds) : '';
  for (const phase of phases) {
    const evidence = metadata.verification_evidence?.[phase];
    if (!evidence?.local_manifest) issues.push(`${phase} 缺少本地证明 manifest`);
    // Historical diagnosis proofs were executed with MODEL_REPRO=1. Their
    // evidence remains bound to that immutable command, while Excel exports
    // use the equivalent canonical command without the internal prefix.
    if (!evidence?.verify_cmds_sha256 || ![verifyCmdsSha256, rawVerifyCmdsSha256].includes(evidence.verify_cmds_sha256)) {
      issues.push(`${phase} evidence 未绑定 public.json.verify_cmds 原始命令数组`);
    }
    const resultProof = verifyResult?.[phase];
    if (resultProof && evidence) {
      if (resultProof.session_id !== evidence.session_id) issues.push(`${phase} verify_result 与 evidence 的 session_id 不一致`);
      if (resultProof.result !== evidence.result) issues.push(`${phase} verify_result 与 evidence 的 result 不一致`);
      if (resultProof.trajectory_url !== evidence.trajectory_url) issues.push(`${phase} verify_result 与 evidence 的 trajectory_url 不一致`);
    }
  }

  return {
    issues: [...new Set(issues)],
    phases,
    verifyCmdsSha256,
  };
}

export function assertVerificationExportMetadata(metadata = {}, options = {}) {
  const result = verificationExportMetadataIssues(metadata, options);
  if (result.issues.length) {
    const bugId = String(metadata.bug_id || metadata.sample_id || '未知任务');
    throw new Error(`${bugId} 禁止 Excel 导出：${result.issues.join('；')}`);
  }
  return result;
}
