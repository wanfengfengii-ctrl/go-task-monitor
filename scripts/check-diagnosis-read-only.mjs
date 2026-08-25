#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseMutationAudit } from '../src/trajectory-audit.js';
import { parseTrajectoryJson, validateDiagnosisReadOnlyEvents } from '../src/trajectory-file-validator.js';

const [trajectoryPath, auditPath, workspaceRoot] = process.argv.slice(2);
if (!trajectoryPath || !auditPath || !workspaceRoot) {
  throw new Error('usage: check-diagnosis-read-only.mjs TRAJECTORY AUDIT WORKSPACE');
}

const [trajectoryContent, auditContent] = await Promise.all([
  fs.readFile(path.resolve(trajectoryPath), 'utf8'),
  fs.readFile(path.resolve(auditPath), 'utf8'),
]);
const result = validateDiagnosisReadOnlyEvents(parseTrajectoryJson(trajectoryContent), {
  workspaceRoot: path.resolve(workspaceRoot),
  auditRecords: parseMutationAudit(auditContent),
  requireAudit: true,
});

if (!result.ok) {
  for (const error of result.errors) {
    process.stderr.write(`${error.code}: ${error.message}${error.evidence ? ` (${error.evidence})` : ''}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(result.stats)}\n`);
}
