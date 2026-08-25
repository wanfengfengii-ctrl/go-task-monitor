import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export async function workspaceValidationFingerprint(taskDir, directoryNames = ['workspace', 'pristine']) {
  const hash = crypto.createHash('sha256');

  async function visit(root, relative = '') {
    let children;
    try {
      children = await fsp.readdir(path.join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        hash.update(`missing:${path.basename(root)}:${relative}\n`);
        return;
      }
      throw error;
    }

    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (child.name === '.git' || child.name === '.DS_Store') continue;
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const absolute = path.join(root, childRelative);
      let stat;
      try {
        stat = await fsp.lstat(absolute);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          hash.update(`removed:${path.basename(root)}:${childRelative}\n`);
          continue;
        }
        throw error;
      }
      hash.update(`${path.basename(root)}:${childRelative}:${stat.mode}:${stat.size}:${stat.mtimeMs}\n`);
      if (child.isDirectory()) await visit(root, childRelative);
    }
  }

  for (const directoryName of directoryNames) {
    await visit(path.join(taskDir, directoryName));
  }
  return hash.digest('hex');
}
