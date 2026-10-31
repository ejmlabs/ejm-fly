import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { item } from '../src/item.js';

const root = resolve(import.meta.dirname, '..');
// Keep the disallowed vocabulary encoded so it cannot occur in the scanned sources.
const vocabulary = Buffer.from('b3BlbmFpfGFudGhyb3BpY3xjaGF0Z3B0fGNvZGV4fGNsYXVkZXxjb3BpbG90fGdlbWluaXxncHR8ZGVlcHNlZWt8cGVycGxleGl0eXxtaWRqb3VybmV5fGRhbGwtZXxjdXJzb3J8d2luZHN1cmZ8c3R1ZGlvfGdvb2dsZXxkZWVwbWluZHxjb2hlcmV8eGFpfG1pc3RyYWx8bWljcm9zb2Z0fG1ldGEgYWl8Z3Jva3xsbGFtYXxhbGV4YXxzaXJpfHN0YWJsZSBkaWZmdXNpb258YXNzaXN0YW50', 'base64').toString();
const disallowed = new RegExp(`\\b(?:${vocabulary})\\b`, 'i');
const property = Buffer.from('Y3Vyc29y', 'base64').toString();
// CSS property tokens are syntax; prose remains checked.
const cssProperty = new RegExp(`\\b${property}\\s*:`, 'g');
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(path));
    else if (['.js', '.mjs', '.ts', '.css', '.html', '.md', '.json', '.txt'].includes(extname(path))) result.push(path);
  }
  return result;
}

export function loadedAddresses(source: string, html = false, css = false): string[] {
  if (css) return [...source.matchAll(/(?:url\(\s*|@import\s+)["']?([^\s)"']+)/gi)].map((match) => item(match, 1)).filter((value) => /^(?:https?:)?\/\//i.test(value));
  if (!html) return source.match(/https?:\/\/[^\s'"`<>]+/gi) ?? [];
  const result: string[] = [];
  for (const [tag] of source.matchAll(/<(?:script|img|source|video|audio|link|iframe|embed|object)\b[^>]*>/gi)) {
    for (const [, value] of tag.matchAll(/(?:src|href|srcset|poster|data)\s*=\s*["']([^"']*)["']/gi)) {
      if (value && (/^https?:\/\//i.test(value) || value.startsWith("//"))) result.push(value);
    }
  }
  return result;
}

test('public text follows the vocabulary and self-contained runtime rules', async () => {
  // Vocabulary guards public site text. Tooling paths (e.g. the local browser binary) are exempt.
  const publicPaths = ['README.md', 'index.html', 'styles.css', 'LICENSE', 'THIRD_PARTY_NOTICES', ...await files('src')];
  const toolPaths = [...await files('tools'), ...await files('tests')];
  for (const path of publicPaths) {
    const source = await readFile(resolve(root, path), 'utf8');
    assert.equal(disallowed.test(path.endsWith('.css') ? source.replace(cssProperty, '') : source), false, `Disallowed public vocabulary in ${path}`);
    if (path === 'index.html' || path.startsWith('src/') || path === 'styles.css') {
      assert.deepEqual(loadedAddresses(source, path.endsWith('.html'), path.endsWith('.css')), [], `External runtime address in ${path}`);
    }
  }
  for (const path of toolPaths) {
    const source = await readFile(resolve(root, path), 'utf8');
    if (path === 'tools/browser.ts') continue;
    assert.equal(disallowed.test(source), false, `Disallowed public vocabulary in ${path}`);
  }
});

test('runtime address checking permits source links and catches loaded resources', () => {
  const address = 'https:' + '//example.test/asset.js';
  assert.deepEqual(loadedAddresses(`<a href="${address}">Source</a>`, true), []);
  assert.deepEqual(loadedAddresses(`<script src="${address}"></script>`, true), [address]);
  assert.deepEqual(loadedAddresses(`import '${address}';`), [address]);
});
