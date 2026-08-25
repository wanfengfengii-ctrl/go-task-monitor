#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairGoldTestCollision } from '../src/grader-guards.js';

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 2) throw new Error('usage: check-grader-collisions.mjs TASK_DIR WORKSPACE');
  const result = await repairGoldTestCollision(path.resolve(args[0]), path.resolve(args[1]));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(`GRADER_COLLISION preflight failed: ${error.message}`);
    process.exitCode = 42;
  });
}
