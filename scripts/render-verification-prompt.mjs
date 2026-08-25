#!/usr/bin/env node
import fsp from 'node:fs/promises';
import { directPublicVerifyCommandIssues, verificationProofPrompt } from '../src/verification-proof.js';

const [phase, metadataPath] = process.argv.slice(2);
if (!['pre_fix', 'post_fix'].includes(phase) || !metadataPath) {
  console.error('usage: render-verification-prompt.mjs PHASE PUBLIC_JSON');
  process.exit(2);
}

const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
if (!Array.isArray(metadata.verify_cmds) || !metadata.verify_cmds.length || metadata.verify_cmds.some((command) => typeof command !== 'string' || !command.trim())) {
  console.error('public.json verify_cmds must be a non-empty string array');
  process.exit(3);
}
const commandIssues = directPublicVerifyCommandIssues(metadata.verify_cmds, metadata.task_type);
if (commandIssues.length) {
  console.error(commandIssues.join('; '));
  process.exit(4);
}

process.stdout.write(`${verificationProofPrompt(phase, metadata.verify_cmds)}\n`);
