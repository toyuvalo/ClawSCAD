#!/usr/bin/env node
/**
 * Standalone harness (no Electron, no Playwright) for the web port's
 * mesh → prep → checkpoint chain.
 *
 * THE BUG THIS EXISTS FOR: the chain used to be driven by the client. That is
 * fine in Electron, where the renderer is the app, and silently destructive in
 * a browser. On 2026-08-30 a real generation finished its images and a
 * watertight 516K-vertex mesh and then simply stopped, `prep` and `checkpoint`
 * still pending, because the tab had closed during the ~10-minute mesh. Ten
 * minutes of GPU work sat finished on disk with no checkpoint. To the user that
 * is indistinguishable from "nothing happened".
 *
 * So check 1 below closes the event stream MID-RUN and then insists the
 * checkpoint lands anyway. That is the whole contract: the server finishes the
 * chain with nobody listening. Move the chain back into the client and check 1
 * goes red.
 *
 * The rest guard the ways a server-side chain can go wrong instead: advancing
 * past a stage that failed or was cancelled, and accepting a chain off the
 * network that never terminates.
 *
 * Uses tests/fixtures/fake-claw-gen.exe — a REAL executable, because node's
 * child_process refuses .bat/.cmd without `shell: true` (CVE-2024-27980) and
 * this app is never allowed to use it.
 *
 * Run: node tests/pipeline-chain.js
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
// The fake CLI's checkpoint stage writes this into its cwd, which is the
// workspace. Its presence is the chain's only contract-visible output — the
// same signal tests/studio-recreate.spec.js uses for the desktop chain.
const CHECKPOINT_ARTIFACT = 'fake-gen-checkpoint.scad';

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

/** Poll rather than sleep-and-hope: a fixed wait either flakes or is slow. */
async function until(predicate, { timeout = 20000, interval = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
    await sleep(interval);
  }
}

// ── a server per check, so no check can inherit another's pipeline state ────

async function startServer() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-chain-'));
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
  child.stdout.on('data', (c) => {
    out += c.toString();
  });
  child.stderr.on('data', (c) => {
    out += c.toString();
  });

  const base = `http://127.0.0.1:${port}`;
  try {
    await until(() => out.includes(`http://127.0.0.1:${port}`), { timeout: 15000, what: 'the server to listen' });
  } catch (err) {
    child.kill();
    throw new Error(`${err.message}\n  server said: ${out.trim() || '(nothing)'}`);
  }

  return {
    base,
    workspace,
    artifact: path.join(workspace, CHECKPOINT_ARTIFACT),
    output: () => out,
    async stop() {
      // Hard rule 8: nothing this harness starts outlives it. SIGTERM first so
      // the server's own shutdown() reaps the pipeline child it spawned.
      await new Promise((resolve) => {
        const done = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(done);
          resolve();
        });
        try {
          child.kill();
        } catch {
          clearTimeout(done);
          resolve();
        }
      });
      try {
        fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {}
    },
  };
}

function post(base, route, body) {
  return request(base, route, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

function get(base, route) {
  return request(base, route, { method: 'GET' });
}

function request(base, route, { method, body }) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + route);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`${route} did not answer JSON: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** An SSE client that collects `pipeline:exit` envelopes and can be cut off. */
function openStream(base) {
  const url = new URL(base + '/events');
  const exits = [];
  const state = { exits, req: null, socket: null, closed: false };
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers: { Accept: 'text/event-stream' } },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString();
          let nl;
          while ((nl = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            try {
              const env = JSON.parse(line.slice(6));
              if (env.channel === 'pipeline:exit') exits.push(env.data);
            } catch {}
          }
        });
        state.res = res;
        resolve(state);
      }
    );
    state.req = req;
    state.kill = () => {
      state.closed = true;
      // destroy(), not end(): a tab that is closed does not say goodbye, and
      // the point of check 1 is that the server does not need it to.
      try {
        req.destroy();
      } catch {}
    };
    req.on('error', (err) => {
      if (!state.closed) reject(err);
    });
    req.end();
  });
}

// ── checks ─────────────────────────────────────────────────────────────────

(async () => {
  if (!fs.existsSync(FAKE_CLI)) {
    console.log('SKIP — tests/fixtures/fake-claw-gen.exe has not been built');
    process.exit(0);
  }

  // 1. THE REGRESSION. Start the chain, cut the event stream while the mesh is
  //    still running, and require the checkpoint anyway.
  await check('the chain finishes after the only client disconnects mid-run', async () => {
    const srv = await startServer();
    try {
      const stream = await openStream(srv.base);
      const started = await post(srv.base, '/api/pipeline/start', {
        action: 'mesh',
        args: [],
        chain: ['prep', 'checkpoint'],
      });
      assert.deepStrictEqual(started, { started: true }, 'mesh did not start');

      // Cut the tab off immediately — before the mesh can even exit.
      stream.kill();
      await until(async () => (await get(srv.base, '/api/pipeline/status')).running === false, {
        what: 'the pipeline to go idle',
      });

      assert.ok(
        fs.existsSync(srv.artifact),
        'no checkpoint artifact: the chain died with the client, which is the bug this test exists for'
      );
    } finally {
      await srv.stop();
    }
  });

  // 2. The client is TOLD the run continues, so it can keep its controls locked
  //    rather than re-enabling between stages.
  await check('exit events carry `chained` until the last stage', async () => {
    const srv = await startServer();
    try {
      const stream = await openStream(srv.base);
      await post(srv.base, '/api/pipeline/start', { action: 'mesh', args: [], chain: ['prep', 'checkpoint'] });
      await until(() => stream.exits.length >= 3, { what: 'three stage exits' });

      assert.deepStrictEqual(
        stream.exits.map((e) => [e.action, e.code, e.chained]),
        [
          ['mesh', 0, 'prep'],
          ['prep', 0, 'checkpoint'],
          ['checkpoint', 0, null],
        ]
      );
      stream.kill();
    } finally {
      await srv.stop();
    }
  });

  // 3. Status has to name the stage in flight AND what is still owed, or a
  //    re-opened tab cannot tell a running chain from an idle server.
  await check('status reports the stage in flight and the stages still owed', async () => {
    const srv = await startServer();
    try {
      // `images` sleeps 1200ms in the fake CLI, which is the window to look in.
      await post(srv.base, '/api/pipeline/start', { action: 'images', args: ['x', '-n', '1'], chain: ['mesh'] });
      const mid = await get(srv.base, '/api/pipeline/status');
      assert.strictEqual(mid.running, true);
      assert.strictEqual(mid.action, 'images');
      assert.deepStrictEqual(mid.chain, ['mesh']);

      await until(async () => (await get(srv.base, '/api/pipeline/status')).running === false, {
        what: 'the chain to finish',
      });
      const done = await get(srv.base, '/api/pipeline/status');
      assert.deepStrictEqual(done, { running: false, action: null, job: 'test-job-0001', chain: [] });
    } finally {
      await srv.stop();
    }
  });

  // 4. A stage that did not succeed must not advance. Cancel is the reachable
  //    non-zero exit: the fake CLI's `images` sleeps 1200ms precisely so a test
  //    can get a kill in while it runs.
  await check('a cancelled stage does not advance the chain', async () => {
    const srv = await startServer();
    try {
      await post(srv.base, '/api/pipeline/start', {
        action: 'images',
        args: ['x', '-n', '1'],
        chain: ['mesh', 'prep', 'checkpoint'],
      });
      assert.strictEqual((await get(srv.base, '/api/pipeline/status')).running, true);
      assert.strictEqual(await post(srv.base, '/api/pipeline/cancel'), true);

      await until(async () => (await get(srv.base, '/api/pipeline/status')).running === false, {
        what: 'the cancelled run to stop',
      });
      // Give a wrongly-armed chain every chance to fire before declaring it dead.
      await sleep(1500);
      const after = await get(srv.base, '/api/pipeline/status');
      assert.strictEqual(after.running, false, 'cancel left the chain running');
      assert.deepStrictEqual(after.chain, [], 'cancel left the chain armed');
      assert.ok(!fs.existsSync(srv.artifact), 'a cancelled run still produced a checkpoint');
    } finally {
      await srv.stop();
    }
  });

  // 4b. Cancel alone does NOT prove the exit-code guard: /api/pipeline/cancel
  //    disarms the chain before it kills anything, so check 4 stays green even
  //    if the exit handler advances unconditionally (verified by mutation).
  //    This one gets a stage to fail ON ITS OWN — the fake CLI's `images`
  //    int.Parse's `-n` and exits 1 on garbage — with nothing having disarmed
  //    the chain first. A prep run against a mesh that was never written is the
  //    real-world version: it buries the actual error under a second, worse one.
  await check('a stage that fails on its own does not advance the chain', async () => {
    const srv = await startServer();
    try {
      const stream = await openStream(srv.base);
      const started = await post(srv.base, '/api/pipeline/start', {
        action: 'images',
        args: ['x', '-n', 'not-a-number'],
        chain: ['mesh', 'prep', 'checkpoint'],
      });
      assert.deepStrictEqual(started, { started: true });

      await until(() => stream.exits.length >= 1, { what: 'the failing stage to exit' });
      assert.notStrictEqual(stream.exits[0].code, 0, 'the fixture did not actually fail');
      assert.strictEqual(stream.exits[0].chained, null, 'a failed stage advertised a next stage');

      // Give a wrongly-armed chain every chance to fire before declaring it dead.
      await sleep(1500);
      assert.strictEqual(stream.exits.length, 1, `a failed stage ran ${stream.exits.length - 1} more`);
      const after = await get(srv.base, '/api/pipeline/status');
      assert.strictEqual(after.running, false);
      assert.deepStrictEqual(after.chain, [], 'a failed stage left the chain armed');
      assert.ok(!fs.existsSync(srv.artifact), 'a failed run still produced a checkpoint');
      stream.kill();
    } finally {
      await srv.stop();
    }
  });

  // 5. `chain` comes off the network. A repeating chain would be a
  //    self-restarting GPU job with no button to stop it.
  await check('a malformed or non-terminating chain is refused', async () => {
    const srv = await startServer();
    try {
      const cases = [
        [{ action: 'mesh', chain: 'prep' }, 'a bare string'],
        [{ action: 'mesh', chain: ['mesh'] }, 're-entering the head stage'],
        [{ action: 'mesh', chain: ['prep', 'prep'] }, 'a repeated stage'],
        [{ action: 'mesh', chain: ['rm -rf /'] }, 'an unknown stage'],
        [{ action: 'mesh', chain: ['prep', 'checkpoint', 'images', 'prep'] }, 'an over-long chain'],
      ];
      for (const [body, why] of cases) {
        const r = await post(srv.base, '/api/pipeline/start', { args: [], ...body });
        assert.deepStrictEqual(r, { error: 'bad-chain' }, `${why} was accepted`);
      }
      // ...and refusing it must not leave the server thinking a run is in flight.
      assert.strictEqual((await get(srv.base, '/api/pipeline/status')).running, false);
    } finally {
      await srv.stop();
    }
  });

  // 6. No chain is still a valid request — every `images` run is one.
  await check('a stage with no chain runs alone and stops', async () => {
    const srv = await startServer();
    try {
      const stream = await openStream(srv.base);
      await post(srv.base, '/api/pipeline/start', { action: 'mesh', args: [] });
      await until(() => stream.exits.length >= 1, { what: 'the mesh to exit' });
      await sleep(800);
      assert.strictEqual(stream.exits.length, 1, 'an unchained stage started something else');
      assert.strictEqual(stream.exits[0].chained, null);
      assert.ok(!fs.existsSync(srv.artifact), 'an unchained mesh checkpointed anyway');
      stream.kill();
    } finally {
      await srv.stop();
    }
  });

  console.log(`\npipeline-chain: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
