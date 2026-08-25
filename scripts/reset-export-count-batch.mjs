import fs from 'node:fs/promises';
import path from 'node:path';

const exportRecordsPath = process.env.GO_TASK_MONITOR_EXPORT_RECORDS
  || path.resolve(import.meta.dirname, '../../.task_work/go-task-library/validation/task_exports.json');
const timestamp = process.argv[2] || '2026-08-16T16:14:56.575Z';
const apply = process.argv.includes('--apply');
const records = JSON.parse(await fs.readFile(exportRecordsPath, 'utf8'));
const matches = records.filter((record) => record.lastExportedAt === timestamp);
const invalid = matches.filter((record) => record.count !== 3 || record.excelCount !== 3 || record.trajectoryCount !== 0 || record.lastKind !== 'excel');
if (matches.length !== 18 || invalid.length) {
  throw new Error(`批次保护条件不满足：时间 ${timestamp} 匹配 ${matches.length} 条，异常 ${invalid.length} 条；未执行修改`);
}

const taskIds = new Set(matches.map((record) => record.taskId));
const updated = records.map((record) => taskIds.has(record.taskId)
  ? { ...record, count: 0, excelCount: 0, lastKind: null, lastExportedAt: null }
  : record);
if (apply) {
  const backupPath = `${exportRecordsPath}.bak-${timestamp.replace(/[:.]/g, '-')}`;
  await fs.copyFile(exportRecordsPath, backupPath);
  const temporary = `${exportRecordsPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, exportRecordsPath);
  console.log(JSON.stringify({ apply, updated: matches.length, backupPath, taskIds: [...taskIds] }, null, 2));
} else {
  console.log(JSON.stringify({ apply, wouldUpdate: matches.length, taskIds: [...taskIds] }, null, 2));
}
