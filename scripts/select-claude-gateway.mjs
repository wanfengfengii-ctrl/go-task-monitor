#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 2_500;

function normalizedEntry(value) {
  if (typeof value === 'string') {
    const baseUrl = value.trim();
    return baseUrl ? { baseUrl, healthUrl: baseUrl } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const baseUrl = String(value.base_url || value.baseUrl || value.url || '').trim();
  if (!baseUrl) return null;
  return {
    baseUrl,
    healthUrl: String(value.health_url || value.healthUrl || baseUrl).trim() || baseUrl,
  };
}

export function claudeGatewayCandidates(raw, model = '', fallback = '') {
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    const fallbackEntry = normalizedEntry(fallback);
    return fallbackEntry ? [fallbackEntry] : [];
  }
  let values = parsed;
  if (!Array.isArray(values) && values && typeof values === 'object') {
    values = values[model] || values.models?.[model] || values.gateways || values.default || [];
  }
  if (!Array.isArray(values)) values = [];
  const entries = values.map(normalizedEntry).filter(Boolean);
  const fallbackEntry = normalizedEntry(fallback);
  if (fallbackEntry && !entries.some((entry) => entry.baseUrl === fallbackEntry.baseUrl)) entries.push(fallbackEntry);
  return [...new Map(entries.map((entry) => [entry.baseUrl, entry])).values()];
}

async function probeGateway(entry, { timeoutMs, apiKey, authToken, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const headers = { 'anthropic-version': '2023-06-01' };
    if (apiKey) headers['x-api-key'] = apiKey;
    if (authToken) headers.authorization = `Bearer ${authToken}`;
    const response = await fetchImpl(entry.healthUrl, {
      method: 'GET', headers, redirect: 'manual', signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    const available = response.ok || [301, 302, 307, 308, 404, 405].includes(response.status);
    await response.body?.cancel().catch(() => {});
    return { ...entry, available, latencyMs, status: response.status };
  } catch (error) {
    return { ...entry, available: false, latencyMs: Math.round(performance.now() - startedAt), error: error?.name || 'probe_failed' };
  } finally {
    clearTimeout(timer);
  }
}

export async function selectClaudeGateway({
  raw = '', model = '', fallback = '', timeoutMs = DEFAULT_TIMEOUT_MS,
  apiKey = '', authToken = '', fetchImpl = fetch,
} = {}) {
  const candidates = claudeGatewayCandidates(raw, model, fallback);
  if (candidates.length <= 1) return { selected: candidates[0]?.baseUrl || fallback, probes: [] };
  const probes = await Promise.all(candidates.map((entry) => probeGateway(entry, {
    timeoutMs: Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), apiKey, authToken, fetchImpl,
  })));
  const fastest = probes.filter((entry) => entry.available).sort((left, right) => left.latencyMs - right.latencyMs)[0];
  return { selected: fastest?.baseUrl || fallback || candidates[0]?.baseUrl || '', probes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , model = '', fallback = ''] = process.argv;
  const result = await selectClaudeGateway({
    raw: process.env.GO_PIPELINE_CLAUDE_GATEWAYS_JSON || '', model, fallback,
    timeoutMs: process.env.GO_PIPELINE_CLAUDE_GATEWAY_PROBE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
    apiKey: process.env.ANTHROPIC_API_KEY || '', authToken: process.env.ANTHROPIC_AUTH_TOKEN || '',
  });
  if (result.probes.length) {
    const summary = result.probes.map((entry) => `${entry.baseUrl}=${entry.available ? `${entry.latencyMs}ms` : 'unavailable'}`).join(', ');
    process.stderr.write(`Claude gateway routing: ${summary}; selected=${result.selected || 'default'}\n`);
  }
  process.stdout.write(`${result.selected || fallback}\n`);
}
