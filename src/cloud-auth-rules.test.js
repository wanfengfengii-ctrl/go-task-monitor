import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCloudPublicState,
  isCloudAuthenticationFailure,
  isCloudTransientFailure,
  cloudUploadRetryDelayMs,
  shouldRetryCloudUpload,
} from './cloud-auth-rules.js';

test('cloud authentication failures include unauthorized responses and login redirects', () => {
  assert.equal(isCloudAuthenticationFailure(401), true);
  assert.equal(isCloudAuthenticationFailure(403), true);
  assert.equal(isCloudAuthenticationFailure(302, '/login', 'https://upload.example'), true);
  assert.equal(isCloudAuthenticationFailure(307, 'https://upload.example/login?next=%2F'), true);
});

test('server and unrelated redirects do not trigger an automatic login', () => {
  assert.equal(isCloudAuthenticationFailure(500), false);
  assert.equal(isCloudAuthenticationFailure(302, '/maintenance', 'https://upload.example'), false);
  assert.equal(isCloudAuthenticationFailure(200), false);
});

test('an upload can refresh and retry only once', () => {
  assert.equal(shouldRetryCloudUpload(0, 401), true);
  assert.equal(shouldRetryCloudUpload(1, 401), false);
  assert.equal(shouldRetryCloudUpload(2, 302, '/login', 'https://upload.example'), false);
});

test('transient cloud failures retry with bounded backoff while business errors do not', () => {
  assert.equal(isCloudTransientFailure(429), true);
  assert.equal(isCloudTransientFailure(503), true);
  assert.equal(isCloudTransientFailure(400), false);
  assert.equal(isCloudTransientFailure(0, new Error('fetch failed')), true);
  assert.equal(shouldRetryCloudUpload(2, 503), true);
  assert.equal(shouldRetryCloudUpload(3, 503), false);
  assert.equal(shouldRetryCloudUpload(0, 400), false);
  assert.equal(cloudUploadRetryDelayMs(0), 500);
  assert.equal(cloudUploadRetryDelayMs(4), 8000);
});

test('public cloud state excludes cookies, passwords, accounts and keychain identifiers', () => {
  const state = createCloudPublicState({
    connected: true,
    connectedAs: 'operator',
    autoLoginConfigured: true,
    lastCheckedAt: '2026-08-15T00:00:00.000Z',
    lastRefreshedAt: '2026-08-15T00:00:00.000Z',
    lastError: '',
    cookie: 'secret-cookie',
    password: 'secret-password',
    autoLoginAccount: 'operator',
    keychainService: 'secret-service',
  }, []);

  assert.deepEqual(Object.keys(state).sort(), [
    'autoLoginConfigured',
    'connected',
    'connectedAs',
    'lastCheckedAt',
    'lastError',
    'lastRefreshedAt',
    'uploads',
  ]);
  assert.equal(JSON.stringify(state).includes('secret'), false);
});
