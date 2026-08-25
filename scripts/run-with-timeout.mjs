#!/usr/bin/env node

import { spawn } from 'node:child_process';

const [timeoutValue, command, ...args] = process.argv.slice(2);
const timeoutSeconds = Number(timeoutValue);

if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || !command) {
  console.error('usage: run-with-timeout.mjs TIMEOUT_SECONDS COMMAND [ARGS...]');
  process.exit(2);
}

const child = spawn(command, args, {
  detached: process.platform !== 'win32',
  stdio: 'inherit',
});

let timedOut = false;
let killTimer = null;

function signalChild(signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

const timeout = setTimeout(() => {
  timedOut = true;
  console.error(`command exceeded ${timeoutSeconds} second timeout; terminating process tree`);
  signalChild('SIGTERM');
  killTimer = setTimeout(() => signalChild('SIGKILL'), 5_000);
  killTimer.unref();
}, Math.ceil(timeoutSeconds * 1_000));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    signalChild(signal);
  });
}

child.once('error', (error) => {
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  console.error(error.message);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  if (timedOut) process.exit(124);
  if (Number.isInteger(code)) process.exit(code);
  console.error(`command terminated by ${signal || 'unknown signal'}`);
  process.exit(1);
});
