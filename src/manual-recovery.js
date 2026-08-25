const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => String(value) === String(right[index]));
}

export function validateManualRecoveryBundle({
  metadata,
  pipelineJob,
  pipelineBug,
  recovery,
  preManifest,
  postManifest,
  testSha256,
} = {}) {
  const issues = [];
  const jobId = String(metadata?.pipeline_job_id || '');
  const bugId = String(metadata?.bug_id || '');
  const bugIndex = Number(metadata?.bug_index);
  const verifyCmds = metadata?.verify_cmds;
  const redCommit = String(metadata?.red_commit || '');
  const greenCommit = String(metadata?.green_fix_commit || '');

  if (metadata?.status !== 'manual_recovery_passed') issues.push('任务未标记为人工恢复通过');
  if (!jobId || pipelineJob?.id !== jobId || pipelineJob?.status !== 'passed') issues.push('人工恢复任务不属于已完成流水线');
  if (pipelineJob?.mainCommit !== metadata?.main_commit
    || pipelineJob?.stages?.find((stage) => stage.id === 'project_validate')?.status !== 'passed') {
    issues.push('人工恢复任务的项目基线未通过校验');
  }
  if (!Number.isInteger(bugIndex) || Number(pipelineBug?.bugIndex) !== bugIndex) issues.push('人工恢复 Bug 序号不匹配');
  if (pipelineBug?.disposition !== 'delivered') issues.push('人工恢复 Bug 尚未交付');
  const deliveryStage = pipelineJob?.stages?.find((stage) => stage.id === `bug${bugIndex}_delivery_ready`);
  if (deliveryStage?.status !== 'passed' || deliveryStage?.result?.manualRecovery !== true) {
    issues.push('人工恢复交付节点未通过');
  }
  if (!COMMIT_PATTERN.test(redCommit) || !COMMIT_PATTERN.test(greenCommit)) issues.push('人工恢复红绿提交格式不合法');
  if (pipelineBug?.redCommit !== redCommit || pipelineBug?.greenFixCommit !== greenCommit) issues.push('任务与流水线红绿提交不一致');
  if (recovery?.pipeline_job_id !== jobId || recovery?.bug_id !== bugId) issues.push('人工恢复记录归属不一致');
  if (recovery?.red_commit !== redCommit || recovery?.green_commit !== greenCommit) issues.push('人工恢复记录提交不一致');
  if (recovery?.git_publication?.pushed !== true) issues.push('人工恢复 Git 分支尚未发布');
  if (recovery?.docker_validation?.network !== 'none'
    || recovery?.docker_validation?.results?.['linux/arm64'] !== 'passed'
    || recovery?.docker_validation?.results?.['linux/amd64'] !== 'passed') {
    issues.push('人工恢复双架构离线验证不完整');
  }
  if (!/^[0-9a-f]{64}$/.test(String(testSha256 || ''))
    || metadata?.verification_test_sha256 !== testSha256) {
    issues.push('人工恢复测试文件哈希不一致');
  }

  for (const [phase, manifest, expectedResult, expectedExitCode, expectedCommit] of [
    ['pre_fix', preManifest, 'red', 1, metadata?.bug_base_commit],
    ['post_fix', postManifest, 'green', 0, greenCommit],
  ]) {
    if (manifest?.mode !== 'manual_recovery_after_datastore_loss'
      || manifest?.pipeline_job_id !== jobId
      || manifest?.bug_id !== bugId
      || manifest?.phase !== phase
      || manifest?.result !== expectedResult
      || Number(manifest?.exit_code) !== expectedExitCode
      || manifest?.source_commit !== expectedCommit
      || manifest?.test_sha256 !== testSha256
      || !sameStringArray(manifest?.verify_cmds, verifyCmds)) {
      issues.push(`人工恢复 ${phase} 证明不完整或不一致`);
    }
  }

  return { ok: issues.length === 0, issues };
}
