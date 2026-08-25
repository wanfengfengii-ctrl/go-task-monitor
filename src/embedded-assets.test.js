import assert from 'node:assert/strict';
import test from 'node:test';
import { goEmbeddedDistDirectories, isGoEmbeddedDistPath } from './embedded-assets.js';

test('Go embed dist directories are resolved relative to the declaring package', () => {
  const directories = goEmbeddedDistDirectories([
    { path: 'webembed/assets.go', content: 'package webembed\n\n//go:embed all:dist\nvar assets embed.FS\n' },
    { path: 'other/assets.go', content: 'package other\n\n//go:embed templates/*\nvar templates embed.FS\n' },
  ]);
  assert.deepEqual(directories, ['webembed/dist']);
  assert.equal(isGoEmbeddedDistPath('webembed/dist/index.html', directories), true);
  assert.equal(isGoEmbeddedDistPath('web/dist/index.html', directories), false);
});
