import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import XLSX from 'xlsx';
import { isChineseDescription } from '../src/export-rules.js';

const TARGET_BUG_IDS = new Set([
  'nyh-go-0246-bug-09',
  'nyh-go-0246-bug-10',
  'nyh-go-0247-bug-03',
  'nyh-go-0247-bug-04',
  'nyh-go-0250-bug-09',
  'nyh-go-0250-bug-10',
]);

const SUCCESS_CRITERIA_OVERRIDES = new Map([
  [
    'nyh-go-0246-bug-09',
    '固化判定必须计入已持久化的无效读数和窗口外读数；监测历史中只要存在此类读数，就不得完成固化，必须保持未完成或转入返工。',
  ],
]);

const GOLD_ROOT_CAUSE_OVERRIDES = new Map([
  [
    'nyh-go-0246-bug-09',
    'service/cure.go、cure/duty.go、store/repos_seam.go 中的 service.processCureAttempt 根本原因是有效读数达到要求时长后，窗口外读数被以 retryable/SENSOR_FORMAT 且不含 reading 数据的形式持久化；完成判定只加载 accepted 读数，仍看到此前的有效跨度且 DueAt 已到，于是忽略异常观测并把 duty 标记为 completed。',
  ],
]);

function cloudSourceUrl(value, sessionId) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' || path.basename(url.pathname) !== `trajectory_${sessionId}.jsonl`) {
    throw new Error(`${sessionId} 的云盘轨迹链接与 Session 不匹配`);
  }
  url.search = '';
  return url.href;
}

function parseEvents(content, label) {
  const source = content.toString('utf8').trim();
  let events;
  try {
    events = source.startsWith('[')
      ? JSON.parse(source)
      : source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    throw new Error(`${label} 不是有效的 JSONL：${error.message}`);
  }
  if (!Array.isArray(events) || !events.length || events.some((event) => !event || typeof event !== 'object' || Array.isArray(event))) {
    throw new Error(`${label} 没有有效的轨迹事件`);
  }
  return events;
}

async function downloadArtifact({ url, sessionId, destination, label }) {
  const response = await fetch(cloudSourceUrl(url, sessionId));
  if (!response.ok) throw new Error(`${label} 云盘下载失败：HTTP ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  const events = parseEvents(content, label);
  const sessionIds = [...new Set(events
    .map((event) => String(event.sessionId || event.session_id || '').trim().toLowerCase())
    .filter(Boolean))];
  if (sessionIds.length !== 1 || sessionIds[0] !== sessionId) {
    throw new Error(`${label} 正文 Session 与导出记录不一致`);
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, destination);

  return {
    eventCount: events.length,
    totalBytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

async function main() {
  const workbookPath = path.resolve(process.argv[2] || '');
  const archivePath = path.resolve(process.argv[3] || path.join(process.cwd(), '..', '.task_work/go-task-library/validation/archived_tasks.json'));
  if (!process.argv[2]) throw new Error('用法：node scripts/restore-archived-cloud-exports.mjs <历史 Excel> [archived_tasks.json]');

  const managedLibraryRoot = path.resolve(path.dirname(archivePath), '..');
  const artifactRoot = path.join(path.dirname(archivePath), 'archived-trajectories');
  const workbook = XLSX.readFile(workbookPath);
  const rows = workbook.SheetNames.flatMap((sheetName) => XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' }));
  const sourceRows = new Map(rows
    .filter((row) => TARGET_BUG_IDS.has(String(row.bug_id || '').trim()))
    .map((row) => [String(row.bug_id).trim(), row]));
  const archive = JSON.parse(await fs.readFile(archivePath, 'utf8'));
  const archivedRows = new Map(archive.map((record) => [record.bug_id, record]));

  for (const bugId of TARGET_BUG_IDS) {
    if (!sourceRows.has(bugId)) throw new Error(`${bugId} 不在历史 Excel 中`);
    if (!archivedRows.has(bugId)) throw new Error(`${bugId} 不在历史归档中`);
  }

  const recoveredAt = new Date().toISOString();
  for (const bugId of TARGET_BUG_IDS) {
    const row = sourceRows.get(bugId);
    const record = archivedRows.get(bugId);
    const successCriteria = SUCCESS_CRITERIA_OVERRIDES.get(bugId) || String(row.success_criteria || '').trim();
    const goldRootCause = GOLD_ROOT_CAUSE_OVERRIDES.get(bugId) || String(row.gold_root_cause || '').trim();
    if (!isChineseDescription(successCriteria)) {
      throw new Error(`${bugId} 的 success_criteria 必须以中文为主体`);
    }
    if (!isChineseDescription(goldRootCause)) {
      throw new Error(`${bugId} 的 gold_root_cause 必须以中文为主体`);
    }
    const sessionId = String(row['session  id'] || '').trim().toLowerCase();
    if (sessionId !== String(record.sessionId || '').trim().toLowerCase()) {
      throw new Error(`${bugId} 的归档 Session 与历史 Excel 不一致`);
    }

    const taskRoot = path.join(artifactRoot, record.id);
    const mainFilename = `trajectory_${sessionId}.jsonl`;
    const mainPath = path.join(taskRoot, mainFilename);
    const mainArtifact = await downloadArtifact({
      url: row.trajectory,
      sessionId,
      destination: mainPath,
      label: `${bugId} 主轨迹`,
    });

    let verificationEvidence;
    try {
      verificationEvidence = JSON.parse(String(row.verify_result || ''));
    } catch (error) {
      throw new Error(`${bugId} 的 verify_result 不是有效 JSON：${error.message}`);
    }
    const expectedPhases = row.task_type === 'diagnosis' ? ['pre_fix'] : ['pre_fix', 'post_fix'];
    const archiveProofs = {};
    for (const phase of expectedPhases) {
      const evidence = verificationEvidence[phase];
      const expectedResult = phase === 'pre_fix' ? 'red' : 'green';
      if (!evidence || evidence.result !== expectedResult || !evidence.session_id || !evidence.trajectory_url) {
        throw new Error(`${bugId} 的 ${phase} 云盘证明不完整`);
      }
      const proofFilename = `trajectory_${evidence.session_id}.jsonl`;
      const proofPath = path.join(taskRoot, 'proofs', phase, proofFilename);
      archiveProofs[phase] = {
        ...await downloadArtifact({
          url: evidence.trajectory_url,
          sessionId: evidence.session_id,
          destination: proofPath,
          label: `${bugId} ${phase} 证明`,
        }),
        path: path.relative(managedLibraryRoot, proofPath),
        filename: proofFilename,
        sessionId: evidence.session_id,
        result: evidence.result,
        trajectoryUrl: evidence.trajectory_url,
      };
    }

    Object.assign(record, {
      task_type: row.task_type,
      bug_category: row.bug_category,
      repo_url: row.repo_url,
      go_version: row.go_version,
      go_mod_version: String(row.go_version).match(/go\.mod\s+go\s+([0-9.]+)/i)?.[1] || record.go_mod_version || '',
      repro_determinism: row.repro_determinism,
      user_query: row.user_query,
      trajectory: row.trajectory,
      trajectoryUrl: row.trajectory,
      verify_cmds: row.verify_cmds,
      gold_root_cause: goldRootCause,
      success_criteria: successCriteria,
      verify_result: row.verify_result,
      harness: row.harness,
      generator_model: row.generator_model,
      verification_evidence: verificationEvidence,
      verificationEvidenceRecorded: true,
      trajectoryUploadRecorded: true,
      eventCount: mainArtifact.eventCount,
      totalBytes: mainArtifact.totalBytes,
      sha256: mainArtifact.sha256,
      archiveTrajectoryPath: path.relative(managedLibraryRoot, mainPath),
      archiveTrajectoryFilename: mainFilename,
      archiveProofs,
      archiveExportReady: true,
      archiveSourceWorkbook: path.basename(workbookPath),
      archiveCloudValidatedAt: recoveredAt,
      archiveReason: 'Recovered from pre-clean Excel and verified Tencent COS originals',
    });
    console.log(`${bugId}: ${mainArtifact.eventCount} events, ${mainArtifact.totalBytes} bytes, ${mainArtifact.sha256}`);
  }

  const temporary = `${archivePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(archive, null, 2)}\n`);
  await fs.rename(temporary, archivePath);
  console.log(`已恢复 ${TARGET_BUG_IDS.size} 条云盘导出记录：${archivePath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
