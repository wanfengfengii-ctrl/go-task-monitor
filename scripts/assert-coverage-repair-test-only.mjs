#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { assertCoverageRepairOnlyChangesTests } from '../src/coverage-repair.js';

if (process.argv.length !== 4) {
  throw new Error('usage: assert-coverage-repair-test-only.mjs BASELINE WORKSPACE');
}

const result = await assertCoverageRepairOnlyChangesTests(
  path.resolve(process.argv[2]),
  path.resolve(process.argv[3]),
);
process.stdout.write(`${JSON.stringify(result)}\n`);
