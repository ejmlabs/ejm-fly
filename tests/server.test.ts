import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request, type IncomingHttpHeaders } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { startServer, ICON_FILES } from '../tools/serve.js';

const root = resolve(import.meta.dirname, '..');
// Its own outDir: deploy.test.ts builds dist in a parallel worker, and a build empties dist first.
let dist: string;
beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'calm-server-'));
  execFileSync('npx', ['vite', 'build', '--outDir', dist], { cwd: root, stdio: 'ignore' });
});
afterAll(() => rm(dist, { recursive: true, force: true }));

interface FetchResult { status: number | undefined; headers: IncomingHttpHeaders; body: string }

function fetchRaw(base: string, path: string, method = 'GET', headers: Record<string, string> = {}): Promise<FetchResult> {
  return new Promise((accept, reject) => {
    const req = request(base, { path, method, headers }, (response) => {
      let body = ''; response.setEncoding('utf8'); response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => { accept({ status: response.statusCode, headers: response.headers, body }); });
    });
    req.on('error', reject); req.end();
  });
}

test('static server provides module MIME types and rejects traversal and unsupported methods', async () => {
  const assets = await readdir(resolve(dist, 'assets'));
  const scriptName = assets.find((name) => name.endsWith('.js') && name.startsWith('index-'));
  assert.ok(scriptName, 'dist/assets must contain a built JavaScript bundle');
  const scriptPath = `/assets/${scriptName}`;

  const app = await startServer({ port: 0, root: dist });
  try {
    const script = await fetchRaw(app.url, scriptPath);
    const csp = String(script.headers['content-security-policy'] ?? '');
    assert.equal(script.status, 200); assert.match(script.headers['content-type'] ?? '', /text\/javascript/);
    assert.equal(script.headers['x-content-type-options'], 'nosniff');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /worker-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.equal((await fetchRaw(app.url, scriptPath, 'HEAD')).body, '');
    const zipped = await new Promise<Buffer>((accept, reject) => {
      const req = request(app.url, { path: scriptPath, headers: { 'Accept-Encoding': 'gzip, br' } }, (response) => {
        assert.equal(response.headers['content-encoding'], 'gzip');
        const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('end', () => { accept(Buffer.concat(chunks)); });
      });
      req.on('error', reject); req.end();
    });
    assert.equal(gunzipSync(zipped).toString('utf8'), script.body, 'text is gzipped when accepted, and only then');
    assert.equal(script.headers['content-encoding'], undefined);
    const png = ICON_FILES.find((name) => name.endsWith('.png'));
    assert.ok(png);
    assert.equal((await fetchRaw(app.url, `/${png}`, 'GET', { 'Accept-Encoding': 'gzip' })).headers['content-encoding'], undefined);
    assert.equal((await fetchRaw(app.url, '/')).status, 200);
    assert.equal((await fetchRaw(app.url, '/styles.css')).status, 404);
    assert.equal((await fetchRaw(app.url, '/LICENSE')).status, 200);
    assert.equal((await fetchRaw(app.url, '/THIRD_PARTY_NOTICES')).status, 200);
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/.git/config', '/.orch/BRIEF.md', '/assets/%00', '/assets%5cmain.js']) {
      assert.equal((await fetchRaw(app.url, path)).status, 403, path);
    }
    for (const path of ['/README.md', '/package.json', '/notes.md', '/secret.md', '/shots/desktop.png', '/shots/', '/node_modules/playwright-core/package.json', '/tools/serve.ts', '/tests/server.test.ts', '/missing.js', '/src/rng.js', '/vendor/three/three.module.js']) {
      assert.equal((await fetchRaw(app.url, path)).status, 404, path);
    }
    assert.equal((await fetchRaw(app.url, '/%not-valid')).status, 400);
    assert.equal((await fetchRaw(app.url, scriptPath, 'POST')).status, 405);
  } finally { await app.close(); }
});

test('static server serves exactly the shipped icons with image types', async () => {
  const app = await startServer({ port: 0, root: dist });
  try {
    for (const name of ICON_FILES) {
      const icon = await fetchRaw(app.url, `/${name}`, 'HEAD');
      assert.equal(icon.status, 200, name);
      assert.equal(icon.headers['content-type'], name.endsWith('.svg') ? 'image/svg+xml' : 'image/png', name);
    }
    for (const name of ['favicon-x.png', 'favicon.ico', 'favicon.png']) {
      assert.equal((await fetchRaw(app.url, `/${name}`)).status, 404, name);
    }
  } finally {
    await app.close();
  }
});
