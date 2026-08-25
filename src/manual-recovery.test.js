import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManualRecoveryBundle } from './manual-recovery.js';

test('manual recovery requires matching red, green, Git, Docker and test evidence', () => {
  const redCommit = '1'.repeat(40);
  const greenCommit = '2'.repeat(40);
  const testSha256 = 'a'.repeat(64);
  const verifyCmds = ["go test ./internal/store -run '^TestRecovery$' -count=1 -v"];
  const metadata = {
    status: 'manual_recovery_passed',
    pipeline_job_id: 'pipeline-recovery-test',
    main_commit: '4'.repeat(40),
    bug_id: 'bug-07',
    bug_index: 7,
    bug_base_commit: '3'.repeat(40),
    red_commit: redCommit,
    green_fix_commit: greenCommit,
    verification_test_sha256: testSha256,
    verify_cmds: verifyCmds,
  };
  const pipelineJob = {
    id: metadata.pipeline_job_id,
    status: 'passed',
    mainCommit: metadata.main_commit,
    stages: [
      { id: 'project_validate', status: 'passed' },
      { id: 'bug7_delivery_ready', status: 'passed', result: { manualRecovery: true } },
    ],
  };
  const pipelineBug = {
    bugIndex: 7,
    disposition: 'delivered',
    redCommit,
    greenFixCommit: greenCommit,
  };
  const recovery = {
    pipeline_job_id: metadata.pipeline_job_id,
    bug_id: metadata.bug_id,
    red_commit: redCommit,
    green_commit: greenCommit,
    git_publication: { pushed: true },
    docker_validation: {
      network: 'none',
      results: { 'linux/arm64': 'passed', 'linux/amd64': 'passed' },
    },
  };
  const manifest = (phase, result, exitCode, sourceCommit) => ({
    mode: 'manual_recovery_after_datastore_loss',
    pipeline_job_id: metadata.pipeline_job_id,
    bug_id: metadata.bug_id,
    phase,
    result,
    exit_code: exitCode,
    source_commit: sourceCommit,
    test_sha256: testSha256,
    verify_cmds: verifyCmds,
  });
  const input = {
    metadata,
    pipelineJob,
    pipelineBug,
    recovery,
    preManifest: manifest('pre_fix', 'red', 1, metadata.bug_base_commit),
    postManifest: manifest('post_fix', 'green', 0, greenCommit),
    testSha256,
  };

  assert.deepEqual(validateManualRecoveryBundle(input), { ok: true, issues: [] });

  const tampered = structuredClone(input);
  tampered.postManifest.test_sha256 = 'b'.repeat(64);
  const invalid = validateManualRecoveryBundle(tampered);
  assert.equal(invalid.ok, false);
  assert.match(invalid.issues.join('\n'), /post_fix/);
});
