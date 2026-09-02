#!/usr/bin/env node
/**
 * Standalone harness for the browser Workbench's server half (web/server.js).
 *
 * The Workbench is the one place the web port WRITES into the workspace, so the
 * checks below are mostly about where that write is allowed to land:
 *
 *  - "open this checkpoint" means copying its .scad over `active.scad`, because
 *    that is the file CLAUDE.md points Claude at. It is deliberately NOT a
 *    registry write: clawscad.json belongs to the desktop app (server.js design
 *    rule 4), and a second writer on a shared JSON is the composer-state.json
 *    bug over again. Check 5 holds that line by comparing bytes, not the parse.
 *  - every path still comes off the network, so `active.scad` itself, a
 *    non-.scad, and anything outside the workspace are all refused.
 *  - the mesh route prefers a sibling .3mf over a sibling .stl over rendering.
 *    That ordering is what makes the Workbench usable on a phone at all: the
 *    same model is routinely a 2.6 MB 3MF and a 109 MB STL, and only one of
 *    those parses on a handset.
 *
 * Rendering itself is NOT exercised here — it needs a real OpenSCAD, and the
 * one on the host machine would make this harness pass or fail for reasons that
 * have nothing to do with the code. The render path is verified in a browser
 * against the live server instead.
 *
 * Run: node tests/web-workbench.js
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

async function startServer({ seed } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-wb-'));
  if (typeof seed === 'function') seed(workspace);
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [SERVER, '--workspace', workspace, '--state', path.join(workspace, '.state'), '--host', '127.0.0.1', '--port', String(port)],
    { cwd: APP_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
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

function request(base, route, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + route);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: { 'Content-Type': 'application/json' },
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

const postJson = async (base, route, body) => {
  const r = await request(base, route, { method: 'POST', body: JSON.stringify(body ?? {}) });
  try {
    return { status: r.status, body: JSON.parse(r.buf.toString()) };
  } catch {
    return { status: r.status, body: null };
  }
};

// A 3MF is a zip and an STL has a 80-byte header; neither is parsed here, so
// any non-empty bytes with the right extension prove the routing.
const FAKE_3MF = Buffer.from('PK fake 3mf');
const FAKE_STL = Buffer.alloc(200, 0x20);

const seedModel = (ws) => {
  fs.writeFileSync(path.join(ws, 'widget.scad'), '// a widget\ncube([10,10,10]);\n');
};

(async () => {
  // 1. Opening a checkpoint is what makes the Workbench a Workbench.
  await check('select copies the checkpoint over active.scad', async () => {
    const srv = await startServer({ seed: seedModel });
    try {
      const { status, body } = await postJson(srv.base, '/api/checkpoint/select', { file: 'widget.scad' });
      assert.strictEqual(status, 200, `select answered ${status}`);
      assert.strictEqual(body.ok, true, `select refused: ${body && body.error}`);
      assert.strictEqual(body.file, 'widget.scad');
      assert.ok(body.source.includes('cube'), 'select did not return the source');
      const active = fs.readFileSync(path.join(srv.workspace, 'active.scad'), 'utf-8');
      assert.ok(active.includes('cube([10,10,10])'), 'active.scad does not hold the selected model');
    } finally {
      await srv.stop();
    }
  });

  // 2. studio.js's recent list passes an ID and nothing else, and an adopted
  //    file's ID exists only in the reconciled view — so the server has to be
  //    able to resolve one on its own.
  await check('select resolves an adopted checkpoint by id alone', async () => {
    const srv = await startServer({ seed: seedModel });
    try {
      const list = await getJson(srv.base, '/api/checkpoints');
      const id = Object.keys(list.body.checkpoints)[0];
      assert.ok(id, 'nothing was adopted, so this check proves nothing');
      const { body } = await postJson(srv.base, '/api/checkpoint/select', { id });
      assert.strictEqual(body.ok, true, `select by id failed: ${body && body.error}`);
      assert.strictEqual(body.file, 'widget.scad');
    } finally {
      await srv.stop();
    }
  });

  // 3. Every one of these is a path off the network.
  await check('select refuses active.scad, a non-.scad and a path outside the workspace', async () => {
    const srv = await startServer({
      seed: (ws) => {
        seedModel(ws);
        fs.writeFileSync(path.join(ws, 'active.scad'), 'cube(1);\n');
        fs.writeFileSync(path.join(ws, 'notes.txt'), 'hello\n');
      },
    });
    try {
      for (const file of ['active.scad', 'notes.txt', '../escape.scad', path.join(os.tmpdir(), 'elsewhere.scad')]) {
        const { status, body } = await postJson(srv.base, '/api/checkpoint/select', { file });
        assert.strictEqual(status, 400, `${file} was accepted with ${status}`);
        assert.strictEqual(body.ok, false, `${file} was accepted`);
      }
    } finally {
      await srv.stop();
    }
  });

  // 4. 3MF before STL before a render. The phone case depends on this order.
  await check('mesh prefers a sibling .3mf over a sibling .stl', async () => {
    const srv = await startServer({
      seed: (ws) => {
        seedModel(ws);
        fs.writeFileSync(path.join(ws, 'widget.stl'), FAKE_STL);
        fs.writeFileSync(path.join(ws, 'widget.3mf'), FAKE_3MF);
      },
    });
    try {
      const { body } = await getJson(srv.base, '/api/checkpoint/mesh?file=widget.scad');
      assert.strictEqual(body.ok, true, `mesh failed: ${body && body.error}`);
      assert.strictEqual(body.format, '3mf', `served ${body.format} when a 3MF was beside the model`);
      assert.strictEqual(body.cached, true, 'a sibling mesh was re-rendered instead of being used');
    } finally {
      await srv.stop();
    }
  });

  await check('mesh falls back to a sibling .stl when there is no .3mf', async () => {
    const srv = await startServer({
      seed: (ws) => {
        seedModel(ws);
        fs.writeFileSync(path.join(ws, 'widget.stl'), FAKE_STL);
      },
    });
    try {
      const { body } = await getJson(srv.base, '/api/checkpoint/mesh?file=widget.scad');
      assert.strictEqual(body.ok, true, `mesh failed: ${body && body.error}`);
      assert.strictEqual(body.format, 'stl');
    } finally {
      await srv.stop();
    }
  });

  await check('mesh refuses a file that is not a .scad in this workspace', async () => {
    const srv = await startServer({ seed: seedModel });
    try {
      const a = await getJson(srv.base, '/api/checkpoint/mesh?file=' + encodeURIComponent('../escape.scad'));
      assert.strictEqual(a.body.ok, false, 'a path outside the workspace was rendered');
      const b = await getJson(srv.base, '/api/checkpoint/mesh?file=gone.scad');
      assert.strictEqual(b.body.ok, false, 'a model that is not on disk reported success');
      assert.strictEqual(b.body.fault, 'model', 'a missing model was blamed on the environment');
    } finally {
      await srv.stop();
    }
  });

  // 5. The viewport fetches these bytes directly, so the route has to stream
  //    the mesh AND refuse everything that is not one.
  await check('/api/model/file streams a mesh and refuses anything else', async () => {
    const srv = await startServer({
      seed: (ws) => {
        seedModel(ws);
        fs.writeFileSync(path.join(ws, 'widget.3mf'), FAKE_3MF);
      },
    });
    try {
      const ok = await request(srv.base, '/api/model/file?path=widget.3mf');
      assert.strictEqual(ok.status, 200, `the mesh answered ${ok.status}`);
      assert.strictEqual(Number(ok.headers['content-length']), FAKE_3MF.length, 'wrong Content-Length');
      assert.ok(ok.buf.equals(FAKE_3MF), 'the bytes came back wrong');

      const scad = await request(srv.base, '/api/model/file?path=widget.scad');
      assert.strictEqual(scad.status, 415, 'source was served through the mesh route');
      const outside = await request(srv.base, '/api/model/file?path=' + encodeURIComponent('../escape.3mf'));
      assert.strictEqual(outside.status, 403, 'a path outside the workspace was served');
    } finally {
      await srv.stop();
    }
  });

  // 6. THE LINE THAT MUST NOT MOVE. Opening a checkpoint writes active.scad and
  //    nothing else — clawscad.json is the desktop app's file.
  await check('select never writes clawscad.json', async () => {
    let registryPath = null;
    let before = null;
    const srv = await startServer({
      seed: (ws) => {
        seedModel(ws);
        registryPath = path.join(ws, 'clawscad.json');
        fs.writeFileSync(
          registryPath,
          JSON.stringify(
            { checkpoints: { cp_1: { file: 'widget.scad', parent: null, label: 'widget', created: '2026-01-01T00:00:00.000Z' } }, active: null },
            null,
            2
          )
        );
        before = fs.readFileSync(registryPath);
      },
    });
    try {
      const { body } = await postJson(srv.base, '/api/checkpoint/select', { id: 'cp_1' });
      assert.strictEqual(body.ok, true, 'the select this check depends on did not happen');
      const after = fs.readFileSync(registryPath);
      assert.ok(before.equals(after), 'opening a checkpoint rewrote clawscad.json — it is the desktop app\'s file');
    } finally {
      await srv.stop();
    }
  });

  // 7. /api/env is the port's own account of what it can do. It said
  //    `viewport:false` for a release after the viewport existed.
  await check('/api/env reports the viewport as real and the terminal as absent', async () => {
    const srv = await startServer({ seed: seedModel });
    try {
      const { body } = await getJson(srv.base, '/api/env');
      assert.strictEqual(body.web.viewport, true, 'the port still claims it has no viewport');
      assert.strictEqual(body.web.terminal, false, 'the port claims a terminal it does not have');
      assert.ok(/terminal/i.test(body.web.reason), 'the stated reason no longer names the one missing thing');
    } finally {
      await srv.stop();
    }
  });

  console.log(`\nweb-workbench: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
