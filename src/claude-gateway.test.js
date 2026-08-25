import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeGatewayCandidates, selectClaudeGateway } from '../scripts/select-claude-gateway.mjs';

test('gateway candidates can be scoped to the configured Claude model', () => {
  const raw = JSON.stringify({
    'model_hub/glm-52-coding': [
      { base_url: 'https://slow.example', health_url: 'https://slow.example/health' },
      'https://fast.example',
    ],
  });
  assert.deepEqual(claudeGatewayCandidates(raw, 'model_hub/glm-52-coding', 'https://fallback.example').map((entry) => entry.baseUrl), [
    'https://slow.example', 'https://fast.example', 'https://fallback.example',
  ]);
});

test('gateway routing selects the lowest-latency healthy node and ignores 5xx nodes', async () => {
  const delays = new Map([
    ['https://slow.example', [50, 200]],
    ['https://fast.example', [0, 200]],
    ['https://broken.example', [0, 504]],
  ]);
  const fetchImpl = async (url) => {
    const [delay, status] = delays.get(url);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return new Response('', { status });
  };
  const result = await selectClaudeGateway({
    raw: JSON.stringify([...delays.keys()]), model: 'model_hub/glm-52-coding', timeoutMs: 1_000, fetchImpl,
  });
  assert.equal(result.selected, 'https://fast.example');
  assert.equal(result.probes.find((entry) => entry.baseUrl === 'https://broken.example').available, false);
});

test('gateway routing falls back to the existing endpoint when all candidates fail', async () => {
  const result = await selectClaudeGateway({
    raw: JSON.stringify(['https://broken.example']), fallback: 'https://current.example', timeoutMs: 50,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(result.selected, 'https://current.example');
});
