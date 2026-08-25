import assert from 'node:assert/strict';
import test from 'node:test';
import {
  githubRepositoryUrls,
  nextSequentialRepositoryName,
  parseGitHubRepositoryNames,
  validateProvisionedRepository,
} from './github-repository.js';

test('sequential repository names start at go-0001 and advance past existing names', () => {
  assert.equal(nextSequentialRepositoryName([]), 'go-0001');
  assert.equal(nextSequentialRepositoryName(['go-0001', 'unrelated', 'go-0007']), 'go-0008');
  assert.equal(nextSequentialRepositoryName(['go-9999']), 'go-10000');
});

test('GitHub repository coordinates use public and SSH URLs', () => {
  assert.deepEqual(githubRepositoryUrls('wanfengfengii-ctrl', 'go-0002'), {
    owner: 'wanfengfengii-ctrl',
    name: 'go-0002',
    nameWithOwner: 'wanfengfengii-ctrl/go-0002',
    repository: 'https://github.com/wanfengfengii-ctrl/go-0002',
    cloneUrl: 'git@github.com:wanfengfengii-ctrl/go-0002.git',
  });
});

test('GitHub repository responses must describe the expected public empty repository', () => {
  const expected = githubRepositoryUrls('wanfengfengii-ctrl', 'go-0002');
  const names = parseGitHubRepositoryNames('[{"name":"go-0001"},{"name":"docs"}]');
  assert.deepEqual(names, ['go-0001', 'docs']);
  assert.equal(validateProvisionedRepository({
    nameWithOwner: expected.nameWithOwner,
    isPrivate: false,
    isEmpty: true,
    url: expected.repository,
    sshUrl: expected.cloneUrl,
  }, expected), expected);
  assert.throws(() => validateProvisionedRepository({
    nameWithOwner: expected.nameWithOwner,
    isPrivate: false,
    isEmpty: false,
    url: expected.repository,
    sshUrl: expected.cloneUrl,
  }, expected), /必须是空仓库/);
});
