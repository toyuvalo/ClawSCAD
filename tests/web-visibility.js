#!/usr/bin/env node
/**
 * Standalone harness for the web port's two "can the user actually SEE their
 * finished work" paths. Both failures below are silent — the UI reports success
 * and shows nothing — which is the only reason they survived this long.
 *
 * 1. THE RENDER PREVIEW GOES BLIND AFTER A GENERATION.
 *    customize.js loads its preview with
 *    `/api/pipeline/image?path=renders/web/<model>.png`, and
 *    serveWorkspaceImage narrows every image read to `pipelineJobDir` once a
 *    job has produced a candidate. That variable is never cleared, so ONE image
 *    generation 403s every Customize preview for the life of the server
 *    process — and the server here runs for days behind a tunnel, not for the
 *    length of one window. The note still says "Rendered"; the <img> is just
 *    empty. The gate is worth keeping (a path off the network must not wander
 *    the tree); it simply has two legitimate roots, not one.
 *
 * 2. A CHECKPOINT MADE OUTSIDE THE DESKTOP APP IS INVISIBLE.
 *    main.js has reconcileWorkspace(): it adopts .scad files that exist on disk
 *    but are missing from clawscad.json, because "the watcher starts with
 *    ignoreInitial:true, so anything created while the app was closed was
 *    invisible forever". That runs in Electron at window open. The web port has
 *    no watcher and no reconcile, so a checkpoint written by `claw-gen
 *    checkpoint` — which is exactly what the server-side chain now produces —
 *    never appears in the recent list. Real case: the 2026-08-30 cheese-man
 *    sculpt, finished on disk, absent from the browser.
 *
 *    The port reconciles IN MEMORY and never writes clawscad.json. The registry
 *    belongs to the desktop app (server.js design rule 4), and a second writer
 *    on a shared JSON is the composer-state.json bug over again. The last check
 *    here holds that line by comparing the file's bytes before and after.
 *
 * Run: node tests/web-visibility.js
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
const FAKE_CLI = path.join(__dirname, 'fixtures', 'fake-claw-gen.exe');

// A 1x1 PNG — enough to be a real image the server will serve.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-vis-'));
  if (typeof seed === 'function') seed(workspace);
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      SERVER,
      '--workspace', workspace,
      '--state', path.join(workspace, '.state'),
      '--host', '127.0.0.1',
      '--port', String(port),
      '--cli', FAKE_CLI,
    ],
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
      // Hard rule 8: nothing this harness starts outlives it.
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
        res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
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

const postJson = (base, route, body) =>
  request(base, route, { method: 'POST', body: JSON.stringify(body ?? {}) }).then((r) => {
    try { return JSON.parse(r.buf.toString()); } catch { return null; }
  });

// ── checks ─────────────────────────────────────────────────────────────────

(async () => {
  if (!fs.existsSync(FAKE_CLI)) {
    console.log('SKIP — tests/fixtures/fake-claw-gen.exe has not been built');
    process.exit(0);
  }

  const IMG = '/api/pipeline/image?path=renders%2Fweb%2Fmodel.png';

  // 1. THE REGRESSION. A render preview must stay readable after a generation.
  await check('a render preview is still served after a job has run', async () => {
    const srv = await startServer({
      seed: (ws) => {
        fs.mkdirSync(path.join(ws, 'renders', 'web'), { recursive: true });
        fs.writeFileSync(path.join(ws, 'renders', 'web', 'model.png'), TINY_PNG);
      },
    });
    try {
      const before = await request(srv.base, IMG);
      assert.strictEqual(before.status, 200, 'the preview was not readable even before a job');

      // One generation is all it takes: the first `candidate` event sets
      // pipelineJobDir, and nothing ever clears it.
      await postJson(srv.base, '/api/pipeline/start', { action: 'images', args: ['x', '-n', '1'] });
      await until(async () => (await getJson(srv.base, '/api/pipeline/status')).body.running === false, {
        what: 'the generation to finish',
      });

      const after = await request(srv.base, IMG);
      assert.strictEqual(
        after.status,
        200,
        'the render preview 403s after a generation — Customize goes blind, silently, for the life of the process'
      );
    } finally {
      await srv.stop();
    }
  });

  // 2. The gate still has to GATE. Widening it to the render dir must not
  //    widen it to the whole tree — that is the property it exists for.
  await check('the job-dir gate still refuses an unrelated image after a job', async () => {
    const srv = await startServer({
      seed: (ws) => {
        fs.mkdirSync(path.join(ws, 'elsewhere'), { recursive: true });
        fs.writeFileSync(path.join(ws, 'elsewhere', 'secret.png'), TINY_PNG);
      },
    });
    try {
      await postJson(srv.base, '/api/pipeline/start', { action: 'images', args: ['x', '-n', '1'] });
      await until(async () => (await getJson(srv.base, '/api/pipeline/status')).body.running === false, {
        what: 'the generation to finish',
      });

      const r = await request(srv.base, '/api/pipeline/image?path=elsewhere%2Fsecret.png');
      assert.strictEqual(r.status, 403, 'an unrelated workspace image was readable — the gate is gone, not widened');
    } finally {
      await srv.stop();
    }
  });

  // 3. A candidate from the job that is running stays readable — the gate's
  //    actual purpose, and the thing the picture grid depends on.
  await check('a candidate image from the running job is still served', async () => {
    const srv = await startServer();
    try {
      await postJson(srv.base, '/api/pipeline/start', { action: 'images', args: ['x', '-n', '1'] });
      await until(async () => (await getJson(srv.base, '/api/pipeline/status')).body.running === false, {
        what: 'the generation to finish',
      });
      const rel = 'renders/gen/test-job-0001/img/r1-fake-backend-1.png';
      const r = await request(srv.base, `/api/pipeline/image?path=${encodeURIComponent(rel)}`);
      assert.strictEqual(r.status, 200, 'the job\'s own candidate stopped being readable');
    } finally {
      await srv.stop();
    }
  });

  // 4. THE SECOND REGRESSION. A .scad on disk that the registry never heard of
  //    is real work, and the browser has to show it. This is the cheese-man
  //    case: `claw-gen checkpoint` writes the file, nothing writes the registry.
  await check('a .scad on disk but absent from the registry is listed anyway', async () => {
    const srv = await startServer({
      seed: (ws) => {
        fs.writeFileSync(
          path.join(ws, 'clawscad.json'),
          JSON.stringify(
            {
              checkpoints: {
                cp_known_1: { file: 'known.scad', parent: null, label: 'known', created: '2026-01-01T00:00:00.000Z' },
              },
              active: 'cp_known_1',
            },
            null,
            2
          )
        );
        fs.writeFileSync(path.join(ws, 'known.scad'), 'cube(1);\n');
        fs.writeFileSync(
          path.join(ws, 'cheese-sculpt.scad'),
          '// Generated sculpt: "a piece of anthropomorphised cheese"\ncube(2);\n'
        );
      },
    });
    try {
      const { body } = await getJson(srv.base, '/api/checkpoints');
      const files = Object.values(body.checkpoints || {}).map((c) => c.file);
      assert.ok(files.includes('known.scad'), 'the registry entry vanished');
      assert.ok(
        files.includes('cheese-sculpt.scad'),
        'a checkpoint made outside the desktop app is invisible in the browser'
      );
    } finally {
      await srv.stop();
    }
  });

  // 5. active.scad is the working copy, not a checkpoint. main.js excludes it
  //    by name; adopting it would put a duplicate of the current model in the
  //    list under its own name every single time.
  await check('active.scad is never adopted as a checkpoint', async () => {
    const srv = await startServer({
      seed: (ws) => {
        fs.writeFileSync(path.join(ws, 'active.scad'), 'cube(1);\n');
        fs.writeFileSync(path.join(ws, 'real.scad'), 'cube(2);\n');
      },
    });
    try {
      const { body } = await getJson(srv.base, '/api/checkpoints');
      const files = Object.values(body.checkpoints || {}).map((c) => c.file);
      assert.ok(files.includes('real.scad'), 'the real checkpoint was not adopted');
      assert.ok(!files.includes('active.scad'), 'active.scad was adopted as a checkpoint');
    } finally {
      await srv.stop();
    }
  });

  // 6. THE LINE THAT MUST NOT MOVE. Reconciling is a READ. clawscad.json
  //    belongs to the desktop app (server.js design rule 4), and a second
  //    writer on a shared JSON is exactly the composer-state.json bug. Compare
  //    the bytes, not the parse: a reformat is still a write.
  await check('reconciling never writes clawscad.json', async () => {
    let registryPath = null;
    let before = null;
    const srv = await startServer({
      seed: (ws) => {
        registryPath = path.join(ws, 'clawscad.json');
        fs.writeFileSync(registryPath, JSON.stringify({ checkpoints: {}, active: null }, null, 2));
        before = fs.readFileSync(registryPath);
        fs.writeFileSync(path.join(ws, 'adopted.scad'), 'cube(3);\n');
      },
    });
    try {
      const { body } = await getJson(srv.base, '/api/checkpoints');
      assert.ok(
        Object.values(body.checkpoints || {}).some((c) => c.file === 'adopted.scad'),
        'nothing was adopted, so this check proves nothing'
      );
      const after = fs.readFileSync(registryPath);
      assert.ok(before.equals(after), 'the web server rewrote clawscad.json — it is the desktop app\'s file');
    } finally {
      await srv.stop();
    }
  });

  // 7. An adopted entry has to be usable by the UI, not just present. The
  //    recent list reads `file` and `label`; a record missing either renders as
  //    a blank row, which is worse than an absent one.
  await check('an adopted entry carries the fields the recent list renders', async () => {
    const srv = await startServer({
      seed: (ws) => {
        fs.writeFileSync(
          path.join(ws, 'cheese-man-sculpt.scad'),
          '// Generated sculpt: "a piece of anthropomorphised cheese"\ncube(2);\n'
        );
      },
    });
    try {
      const { body } = await getJson(srv.base, '/api/checkpoints');
      const entry = Object.values(body.checkpoints || {}).find((c) => c.file === 'cheese-man-sculpt.scad');
      assert.ok(entry, 'not adopted');
      assert.strictEqual(typeof entry.label, 'string');
      assert.ok(entry.label.length > 0, 'an adopted entry has no label — it would render as a blank row');
      assert.strictEqual(entry.discovered, true, 'an adopted entry should say it was discovered, not registered');
      assert.ok(entry.created, 'an adopted entry has no created date');
    } finally {
      await srv.stop();
    }
  });

  console.log(`\nweb-visibility: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
