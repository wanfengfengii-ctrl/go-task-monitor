function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

function asText(content) {
  if (typeof content === 'string') return content;
  if (content instanceof Uint8Array) return new TextDecoder().decode(content);
  return String(content || '');
}

function embedPatterns(source) {
  const patterns = [];
  for (const match of asText(source).matchAll(/^\s*\/\/go:embed\s+(.+)$/gm)) {
    for (const token of match[1].match(/"(?:\\.|[^"])*"|`[^`]*`|\S+/g) || []) {
      patterns.push(token.replace(/^(?:"|`)|(?:"|`)$/g, ''));
    }
  }
  return patterns;
}

export function goEmbeddedDistDirectories(entries = []) {
  const directories = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const entryPath = normalizePath(entry?.path);
    if (!entryPath.endsWith('.go')) continue;
    const parent = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/')) : '';
    for (const rawPattern of embedPatterns(entry?.content)) {
      const pattern = normalizePath(rawPattern.replace(/^all:/, ''));
      const segments = pattern.split('/');
      const distIndex = segments.indexOf('dist');
      if (distIndex < 0 || segments.slice(0, distIndex + 1).some((segment) => !segment || segment === '..' || /[*?\[]/.test(segment))) continue;
      const directory = normalizePath([parent, ...segments.slice(0, distIndex + 1)].filter(Boolean).join('/'));
      if (directory) directories.add(directory);
    }
  }
  return [...directories].sort();
}

export function isGoEmbeddedDistPath(value, directories = []) {
  const normalized = normalizePath(value).replace(/\/$/, '');
  return directories.some((directory) => normalized === directory || normalized.startsWith(`${directory}/`));
}
