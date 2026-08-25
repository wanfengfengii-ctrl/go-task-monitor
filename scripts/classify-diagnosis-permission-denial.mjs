#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { diagnosisBashMutationIntents } from '../src/trajectory-file-validator.js';

const DIRECT_WRITE_TOOLS = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
  'apply_patch',
  'ApplyPatch',
]);

function deniedCommand(event) {
  if (typeof event?.tool_input?.command === 'string') return event.tool_input.command;
  const message = String(event?.message || '');
  const match = message.match(/^Permission to use Bash with command ([\s\S]*) has been denied\.$/);
  return match?.[1] || '';
}

const input = fs.readFileSync(0, 'utf8').trim();
const event = JSON.parse(input);
const toolName = String(event?.tool_name || '');
let mutation = DIRECT_WRITE_TOOLS.has(toolName);

if (toolName === 'Bash') {
  const command = deniedCommand(event);
  // Unknown Bash denials fail closed; a malformed event must not weaken the
  // diagnosis read-only boundary.
  mutation = !command || diagnosisBashMutationIntents(command, path.resolve('.')).length > 0;
}

process.stdout.write(mutation ? 'mutation\n' : 'read_only\n');
