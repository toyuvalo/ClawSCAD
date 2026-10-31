#!/usr/bin/env node
/**
 * Standalone harness for Find & Print web routes in web/server.js.
 *
 * Spawns server.js with CLAWSCAD_FINDER_FIXTURES and exercises capabilities,
 * search, detail, download guards, model file restrictions, open in ClawSCAD,
 * printer route refusals, and static finder stylesheet.
 *
 * Run: node tests/web-finder.js
 */

'use strict';

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(APP_ROOT, 'web', 'server.js');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'finder');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL — ${name}`);
    console.log(`  ${err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function until(predicate, { timeout = 20000, interval = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
    await sleep(interval);
  }
}

async function startServer() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-wf-'));
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [SERVER, '--workspace', workspace, '--state', path.join(workspace, '.state'), '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        CLAWSCAD_FINDER_FIXTURES: FIXTURES_DIR,
        CLAWSCAD_FINDER_MIN_INTERVAL_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let out = '';
  child.stdout.on('data', (c) => (out += c.toString()));
  child.stderr.on('data', (c) => (out += c.toString()));

  try {
    await until(() => out.includes(`http://127.0.0.1:${port}`), { timeout: 15000, what: 'the server to listen' });
  } catch (err) {
    child.kill();
    throw new Error(`${err.message}\n  server said: ${out.trim() || '(nothing)'}`);
  }

  return {
    base: `http://127.0.0.1:${port}`,
    workspace,
    async stop() {
      // Hard rule: nothing this harness starts outlives it.
      await new Promise((resolve) => {
        const done = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          resolve();
        }, 3000);
        child.once('exit', () => { clearTimeout(done); resolve(); });
        try { child.kill(); } catch { clearTimeout(done); resolve(); }
      });
      try {
        fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {}
    },
  };
}

function request(base, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + route);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const getJson = async (base, route) => {
  const r = await request(base, route);
  try {
    return { status: r.status, body: JSON.parse(r.buf.toString()) };
  } catch {
    return { status: r.status, body: null };
  }
};

const postJson = async (base, route, body, headers = {}) => {
  const r = await request(base, route, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  try {
    return { status: r.status, body: JSON.parse(r.buf.toString()) };
  } catch {
    return { status: r.status, body: null };
  }
};

(async () => {
  let srv;
  try {
    srv = await startServer();

    // 1. GET /api/finder/capabilities
    await check('GET /api/finder/capabilities returns print unavailable, Printables live and three stubs that need an API key', async () => {
      const { status, body } = await getJson(srv.base, '/api/finder/capabilities');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.print.available, false);
      assert.ok(body.print.reason);

      assert.deepStrictEqual(body.sites.map((s) => s.id), ['printables', 'thingiverse', 'myminifactory', 'cults3d']);
      assert.strictEqual(body.sites.find((s) => s.id === 'printables').available, true);
      for (const id of ['thingiverse', 'myminifactory', 'cults3d']) {
        const s = body.sites.find((x) => x.id === id);
        assert.strictEqual(s.available, false, id);
        assert.strictEqual(s.reason, 'needs-key', id);
      }
      assert.ok(!JSON.stringify(body).toLowerCase().includes('makerworld'), 'MakerWorld must not appear anywhere');
    });

    // 2. GET /api/finder/search?q=gridfinity
    await check('GET /api/finder/search?q=gridfinity returns Printables items only', async () => {
      const { status, body } = await getJson(srv.base, '/api/finder/search?q=gridfinity');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(body.items.length > 0);

      assert.ok(body.items.every((i) => i.site === 'printables'), 'only printables items');
      assert.deepStrictEqual(Object.keys(body.sites), ['printables']);
    });

    // 3. GET /api/finder/search?q= (empty query)
    await check('GET /api/finder/search?q= returns 400 for empty query', async () => {
      const { status, body } = await getJson(srv.base, '/api/finder/search?q=');
      assert.strictEqual(status, 400);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.error.code, 'bad-request');
    });

    // 4. GET /api/finder/search?q=gridfinity&sites=printables
    await check('GET /api/finder/search with sites=printables returns only printables items', async () => {
      const { status, body } = await getJson(srv.base, '/api/finder/search?q=gridfinity&sites=printables');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(body.items.length > 0);
      assert.ok(body.items.every((i) => i.site === 'printables'), 'all items must be from printables');
    });

    // 5. GET /api/finder/detail
    await check('GET /api/finder/detail succeeds for valid id and returns 404 for id 404', async () => {
      const okRes = await getJson(srv.base, '/api/finder/detail?site=printables&id=543553');
      assert.strictEqual(okRes.status, 200);
      assert.strictEqual(okRes.body.ok, true);
      assert.strictEqual(okRes.body.detail.siteId, '543553');

      const notFoundRes = await getJson(srv.base, '/api/finder/detail?site=printables&id=404');
      assert.strictEqual(notFoundRes.status, 404);
      assert.strictEqual(notFoundRes.body.ok, false);
      assert.strictEqual(notFoundRes.body.error.code, 'not-found');
    });

    // 6. POST /api/finder/download with text/plain (cross-site-form guard)
    await check('POST /api/finder/download with text/plain answers 415 (JSON required guard)', async () => {
      const r = await request(srv.base, '/api/finder/download', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'non-json-form-payload',
      });
      assert.strictEqual(r.status, 415);
      const parsed = JSON.parse(r.buf.toString());
      assert.strictEqual(parsed.ok, false);
      assert.strictEqual(parsed.error.code, 'bad-request');
    });

    // 7. POST /api/finder/download with application/json
    let downloadedRelPath = null;
    await check('POST /api/finder/download saves model file and writes source.json with provenance', async () => {
      const { status, body } = await postJson(srv.base, '/api/finder/download', {
        site: 'printables',
        id: '543553',
        fileId: '9990001',
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.name, 'cube-20mm.stl');
      downloadedRelPath = body.path;

      const cubePath = path.join(srv.workspace, 'models', 'printables-543553', 'cube-20mm.stl');
      assert.ok(fs.existsSync(cubePath), 'cube-20mm.stl must exist in workspace');
      assert.strictEqual(fs.statSync(cubePath).size, 684);

      const sourcePath = path.join(srv.workspace, 'models', 'printables-543553', 'source.json');
      assert.ok(fs.existsSync(sourcePath), 'source.json must exist in model folder');
      const doc = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
      assert.ok(doc.url, 'source.json must have url');
      assert.ok(doc.author, 'source.json must have author');
      assert.ok(doc.licence, 'source.json must have licence');
      assert.ok(doc.fetched, 'source.json must have fetched');
    });

    // 8. Servability restriction on downloaded models
    await check('models/* paths answer 403 on /api/model/file and /api/model/download while meshes/* serves 200', async () => {
      const rModelFile = await request(srv.base, '/api/model/file?path=models/printables-543553/cube-20mm.stl');
      assert.strictEqual(rModelFile.status, 403, 'GET /api/model/file on downloaded model must be refused');

      const rModelDl = await request(srv.base, '/api/model/download?path=models/printables-543553/cube-20mm.stl');
      assert.strictEqual(rModelDl.status, 403, 'GET /api/model/download on downloaded model must be refused');

      // Copying to meshes/x.stl allows serving through /api/model/file
      const meshesDir = path.join(srv.workspace, 'meshes');
      fs.mkdirSync(meshesDir, { recursive: true });
      const cubeSrc = path.join(srv.workspace, 'models', 'printables-543553', 'cube-20mm.stl');
      fs.copyFileSync(cubeSrc, path.join(meshesDir, 'x.stl'));

      const rMeshFile = await request(srv.base, '/api/model/file?path=meshes/x.stl');
      assert.strictEqual(rMeshFile.status, 200, 'GET /api/model/file on meshes/x.stl must succeed');
      assert.strictEqual(rMeshFile.headers['content-type'], 'model/stl');
    });

    // 9. POST /api/finder/open
    let firstScadName = null;
    await check('POST /api/finder/open creates a compliant .scad referencing meshes/ in workspace root', async () => {
      const { status, body } = await postJson(srv.base, '/api/finder/open', {
        site: 'printables',
        id: '543553',
        path: downloadedRelPath || 'models/printables-543553/cube-20mm.stl',
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.ok(body.scad);
      firstScadName = body.scad;

      assert.ok(firstScadName.length <= 30, `scad name "${firstScadName}" exceeds 30 characters`);
      assert.ok(firstScadName.endsWith('.scad'));

      const fullScadPath = path.join(srv.workspace, firstScadName);
      assert.ok(fs.existsSync(fullScadPath), 'created .scad file must exist');

      const content = fs.readFileSync(fullScadPath, 'utf-8');
      const lines = content.split('\n');
      assert.ok(lines[0].startsWith('//'), 'first line must start with // comment');
      assert.ok(lines[0].includes('Printables'), 'first line must mention Printables');
      assert.ok(lines[0].includes('543553'), 'first line must mention 543553');
      assert.match(content, /import\("meshes\/[^"]+\.stl"/, 'scad must contain import("meshes/...stl")');
    });

    // 10. Second POST /api/finder/open
    await check('second POST /api/finder/open creates a new .scad without overwriting the first', async () => {
      const { status, body } = await postJson(srv.base, '/api/finder/open', {
        site: 'printables',
        id: '543553',
        path: downloadedRelPath || 'models/printables-543553/cube-20mm.stl',
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.notStrictEqual(body.scad, firstScadName, 'second open must generate a distinct filename');

      const scads = fs.readdirSync(srv.workspace).filter((f) => f.endsWith('.scad'));
      assert.strictEqual(scads.length, 2, 'workspace must contain exactly 2 .scad files');
      for (const s of scads) {
        assert.ok(s.length <= 30, `scad name "${s}" must be <= 30 chars`);
      }
    });

    // 11. Bad open paths
    await check('POST /api/finder/open refuses traversal, absolute paths, and foreign model paths', async () => {
      const scadsBefore = fs.readdirSync(srv.workspace).filter((f) => f.endsWith('.scad')).length;

      const forbidden = [
        '../../etc/passwd',
        path.resolve(srv.workspace, 'models', 'printables-543553', 'cube-20mm.stl'),
        'models/printables-99999/cube-20mm.stl',
      ];

      for (const fp of forbidden) {
        const { status, body } = await postJson(srv.base, '/api/finder/open', {
          site: 'printables',
          id: '543553',
          path: fp,
        });
        assert.strictEqual(status, 400);
        assert.strictEqual(body.ok, false);
        assert.ok(
          body.error.code === 'path' || body.error.code === 'not-found',
          `expected path or not-found error code, got: ${body.error.code}`
        );
      }

      const scadsAfter = fs.readdirSync(srv.workspace).filter((f) => f.endsWith('.scad')).length;
      assert.strictEqual(scadsAfter, scadsBefore, 'no new scad files should be written on refused open calls');
    });

    // 12. Printer routes refusal
    await check('GET and POST to printer routes answer 403 with desktop-only error', async () => {
      const routes = [
        '/api/finder/printer-status',
        '/api/finder/print-prepare',
        '/api/finder/print-start',
      ];

      for (const r of routes) {
        const rGet = await getJson(srv.base, r);
        assert.strictEqual(rGet.status, 403, `GET ${r} must return 403`);
        assert.strictEqual(rGet.body.ok, false);
        assert.strictEqual(rGet.body.error.code, 'desktop-only');

        const rPost = await postJson(srv.base, r, {});
        assert.strictEqual(rPost.status, 403, `POST ${r} must return 403`);
        assert.strictEqual(rPost.body.ok, false);
        assert.strictEqual(rPost.body.error.code, 'desktop-only');
      }
    });

    // 13. Static CSS route
    await check('GET /style-finder.css answers 200 with text/css content type', async () => {
      const r = await request(srv.base, '/style-finder.css');
      assert.strictEqual(r.status, 200);
      assert.ok(
        String(r.headers['content-type']).includes('text/css'),
        `expected text/css in content-type, got: ${r.headers['content-type']}`
      );
    });
  } finally {
    if (srv) await srv.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
