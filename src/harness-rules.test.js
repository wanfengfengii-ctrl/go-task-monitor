import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractClaudeCodeVersion,
  getClaudeHarnessIssues,
  normalizeClaudeCodeVersion,
  upsertClaudeCodeHarness,
} from './harness-rules.js';

test('normalizes and extracts the Claude Code version from one init event', () => {
  assert.equal(normalizeClaudeCodeVersion('2.1.228 (Claude Code)'), '2.1.228 (Claude Code)');
  assert.equal(extractClaudeCodeVersion([
    { type: 'system', subtype: 'init', claude_code_version: '2.1.228' },
    { type: 'assistant' },
  ]), '2.1.228 (Claude Code)');
  assert.equal(extractClaudeCodeVersion([
    { type: 'system', subtype: 'init', claude_code_version: '2.1.228' },
    { type: 'system', subtype: 'init', claude_code_version: '2.1.229' },
  ]), '');
});

test('upserts one canonical Claude Code tool and version pair', () => {
  const input = 'backend=docker-target; platform=linux/arm64,linux/amd64; container_network=none; target_cli=claude; go=go1.25.6;';
  const output = upsertClaudeCodeHarness(input, '2.1.228');
  assert.equal(
    output,
    'backend=docker-target; platform=linux/arm64,linux/amd64; container_network=none; target_cli=Claude Code CLI; target_cli_version=2.1.228 (Claude Code); go=go1.25.6;',
  );
  assert.deepEqual(getClaudeHarnessIssues(output), []);
  assert.deepEqual(getClaudeHarnessIssues('backend=docker-target; target_cli=claude;'), [
    '缺少生成轨迹的工具版本 target_cli_version=x.y.z (Claude Code)',
  ]);
  assert.deepEqual(getClaudeHarnessIssues('backend=docker-target; target_cli=other;'), [
    '缺少生成轨迹的工具名 target_cli=Claude Code CLI',
    '缺少生成轨迹的工具版本 target_cli_version=x.y.z (Claude Code)',
  ]);
});
