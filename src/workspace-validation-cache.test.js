import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { workspaceValidationFingerprint } from './workspace-validation-cache.js';

test('workspace validation fingerprint changes when a required root file is restored', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-validation-cache-'));
  try {
    await Promise.all([
      mkdir(path.join(root, 'workspace'), { recursive: true }),
      mkdir(path.join(root, 'pristine'), { recursive: true }),
    ]);
    await writeFile(path.join(root, 'workspace', 'go.mod'), 'module example.com/cache\n\ngo 1.23\n');
    const before = await workspaceValidationFingerprint(root);
    await writeFile(path.join(root, 'workspace', 'benzhi.Dockerfile'), 'FROM golang:1.23.4\n');
    const after = await workspaceValidationFingerprint(root);
    assert.notEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
