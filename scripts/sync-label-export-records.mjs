import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '../..');
const monitorDir = path.resolve(scriptDir, '..');
const sourcePath = path.join(projectDir, 'outputs/go-batch-10-final-20260813/GO语言标注-2_Claude批次10_轨迹已回填_字段改写.xlsx');
const outputPath = path.join(monitorDir, 'public/label_export_records.json');

const workbook = XLSX.readFile(sourcePath);
const sheet = workbook.Sheets['智能表1'];
if (!sheet) throw new Error('源工作簿缺少“智能表1”工作表');

const records = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  .filter((record) => typeof record.bug_id === 'string' && record.bug_id.trim());

const duplicateBugIds = records
  .map((record) => record.bug_id)
  .filter((bugId, index, bugIds) => bugIds.indexOf(bugId) !== index);
if (duplicateBugIds.length) {
  throw new Error(`源工作簿存在重复 bug_id：${[...new Set(duplicateBugIds)].join(', ')}`);
}

fs.writeFileSync(outputPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
console.log(`已同步 ${records.length} 条导出字段到 ${outputPath}`);
