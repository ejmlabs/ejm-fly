import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CSP, CSP_HEADER, ICON_FILES } from '../tools/serve.js';

const root = resolve(import.meta.dirname, '..');
const ALLOWED_TOP = new Set([
  'LICENSE', 'THIRD_PARTY_NOTICES', '_headers', 'index.html', '404.html', 'assets',
  ...ICON_FILES,
]);

async function walk(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}

test('meta CSP matches the header policy', async () => {
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  assert.ok(meta);
  assert.equal(meta[1], CSP);
  assert.equal(CSP_HEADER, `${CSP}; frame-ancestors 'none'`);
});

test('build output holds only the Vite public tree and host headers', async () => {
  execFileSync('npx', ['vite', 'build'], { cwd: root, stdio: 'ignore' });
  const headers = await readFile(resolve(root, 'dist/_headers'), 'utf8');
  assert.ok(headers.includes(`Content-Security-Policy: ${CSP_HEADER}`));
  assert.match(headers, /\/assets\/\*[\s\S]*Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/);
  for (const name of ['X-Content-Type-Options: nosniff', 'X-Frame-Options: DENY', 'Referrer-Policy: no-referrer']) {
    assert.ok(headers.includes(name));
  }

  const entries = await readdir(resolve(root, 'dist'));
  for (const name of entries) {
    assert.ok(ALLOWED_TOP.has(name), `unexpected dist entry: ${name}`);
  }
  for (const required of ALLOWED_TOP) {
    assert.ok(entries.includes(required), `missing dist entry: ${required}`);
  }

  const files = await walk('dist');
  assert.equal(files.some((path) => path.endsWith('.ts') || path.endsWith('.map')), false, 'dist must not ship TypeScript or source maps');

  const html = await readFile(resolve(root, 'dist/index.html'), 'utf8');
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, 'no inline scripts');
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  assert.ok(meta);
  assert.equal(meta[1], CSP);
  assert.match(html, /<script\b[^>]*\btype="module"[^>]*\bsrc="\/?assets\//i);

  const assets = await readdir(resolve(root, 'dist/assets'));
  assert.ok(assets.some((name) => extname(name) === '.js'));
  assert.ok(assets.some((name) => extname(name) === '.css') || entries.includes('styles.css'));
});
