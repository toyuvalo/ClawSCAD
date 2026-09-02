// web/server.js — the ClawSCAD Studio web port's server.
//
// A plain node:http server with ZERO dependencies. It serves the static shell
// (web/index.html + the app's real stylesheets + the esbuild bundle) and an API
// that mirrors preload.js's `window.api` in SHAPE, so renderer/studio.js runs
// unmodified against it through web/api-shim.js.
//
// Design rules this file is built on, each with a reason:
//
//  1. NO new dependency. Express is not a dependency of this repo and adding
//     one for a router and a static handler would be a poor trade; node:http
//     plus a switch is the whole thing. Server-Sent Events replace what would
//     otherwise be a WebSocket dependency — the pipeline stream is one-way
//     NDJSON fan-out, which is exactly what SSE is for.
//  2. REUSE the extracted seams. main/tools.js `loadTools`, main/categories.js
//     `loadCategories` and main/composer.js `mergeState` are all Electron-free
//     and are required directly. A second implementation of the override rules
//     or of the `{}`-means-clear semantics would drift within a release.
//  3. This is exposed to the internet behind Cloudflare Access. Every path that
//     reaches the filesystem from a request is resolved and CONTAINMENT-CHECKED
//     against the workspace — not `..`-filtered, which symlinks and absolute
//     paths walk straight past.
//  4. Nothing here writes clawscad.json. The checkpoint registry is read-only
//     to this server; it belongs to the desktop app.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { URL } = require('node:url');

const { loadTools } = require('../main/tools.js');
const { loadCategories } = require('../main/categories.js');
const { mergeState } = require('../main/composer.js');
const { _internal: uploadInternals } = require('../main/uploads.js');

// scad-params.js is an ES module because the BROWSER bundle imports it too —
// one parser, not a server copy and a client copy that drift. This server is
// CommonJS, so it is loaded once via dynamic import at boot (before listen)
// and the two functions are cached here.
let parseScadParams = () => ({ parameters: [], sections: [], skipped: [] });
let buildDefineArgs = () => [];
const scadParamsReady = import('./scad-params.mjs').then((m) => {
  parseScadParams = m.parse;
  buildDefineArgs = m.defineArgs;
});

const APP_ROOT = path.resolve(__dirname, '..');
const WEB_ROOT = __dirname;
const PKG_VERSION = readVersion();

// Mirrors main.js's PIPELINE_* constants. They are not exported from main.js
// (which cannot be required outside Electron), so they are restated here and
// deliberately kept identical.
const PIPELINE_ACTIONS = new Set(['images', 'mesh', 'prep', 'checkpoint']);
const PIPELINE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const PIPELINE_MAX_IMAGE_BYTES = 25 * 1024 * 1024;

// Mirrors main/uploads.js. Only the image class is implemented here — see
// ingestImageBytes() for why the mesh and .scad classes cannot be.
const UPLOAD_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.dxf'];
const UPLOAD_MESH_EXTS = ['.stl', '.3mf', '.obj', '.off', '.amf'];
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

// ── options ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf-8')).version;
  } catch {
    return '0.0.0';
  }
}

const args = parseArgs(process.argv.slice(2));

const WORKSPACE = path.resolve(
  args.workspace || process.env.CLAWSCAD_WORKSPACE || path.join(os.homedir(), 'clawscad-workspace')
);

// The web server's equivalent of Electron's app.getPath('userData'): where the
// composer/studio state file and the optional presets/ overrides live. Defaults
// INSIDE the workspace so a self-hosted install is one directory to back up,
// and so nothing this server writes can land in the desktop app's profile.
const STATE_DIR = path.resolve(args.state || process.env.CLAWSCAD_STATE_DIR || path.join(WORKSPACE, '.clawscad-web'));

// 8730 rather than an 8080/3000/8788-class port: this runs on a machine that
// also runs dev servers, and the default must not be one of the numbers every
// framework reaches for first. Override with --port or $PORT.
const PORT = Number(args.port || process.env.PORT || 8730);
// 127.0.0.1 by default: cloudflared connects over loopback, so the process
// should never be reachable on the LAN without the operator asking for it.
const HOST = args.host || process.env.CLAWSCAD_HOST || '127.0.0.1';

const STATE_FILENAME = 'composer-state.json';
const CHECKPOINT_REGISTRY = 'clawscad.json';

// ── static assets ─────────────────────────────────────────────────────────
//
// An explicit map, not a directory server. The app root holds main.js, the
// preload, and node_modules; a "serve everything under APP_ROOT" handler would
// publish all of it the first time somebody guessed a filename.

const STATIC = new Map([
  ['/', { file: path.join(WEB_ROOT, 'index.html'), type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: path.join(WEB_ROOT, 'index.html'), type: 'text/html; charset=utf-8' }],
  ['/dist/app.js', { file: path.join(WEB_ROOT, 'dist', 'app.js'), type: 'text/javascript; charset=utf-8' }],
  ['/dist/app.js.map', { file: path.join(WEB_ROOT, 'dist', 'app.js.map'), type: 'application/json; charset=utf-8' }],
  ['/style.css', { file: path.join(APP_ROOT, 'style.css'), type: 'text/css; charset=utf-8' }],
  ['/style-studio.css', { file: path.join(APP_ROOT, 'style-studio.css'), type: 'text/css; charset=utf-8' }],
  ['/web.css', { file: path.join(WEB_ROOT, 'web.css'), type: 'text/css; charset=utf-8' }],
  ['/favicon.ico', { file: path.join(APP_ROOT, 'icon.png'), type: 'image/png' }],
]);

// ── path containment ──────────────────────────────────────────────────────

/**
 * Resolve `candidate` (absolute, or relative to the workspace — claw-gen runs
 * with cwd set there and emits both shapes) and return it ONLY if it is really
 * inside the workspace.
 *
 * `..`-rejection is not sufficient and is not what this does: an absolute path
 * on another drive contains no `..`, and neither does a symlink pointing out.
 * Both ends are realpath'd where they exist so a symlink cannot be used to
 * smuggle a read out of the tree, and path.relative does the containment test
 * (case-insensitively on win32, by node's own rules).
 */
function containedInWorkspace(candidate) {
  if (typeof candidate !== 'string' || !candidate) return null;
  if (candidate.includes('\0')) return null;
  let resolved = path.resolve(WORKSPACE, candidate);
  let root = path.resolve(WORKSPACE);
  try {
    root = fs.realpathSync(root);
  } catch {
    /* workspace may not exist yet — fall back to the lexical root */
  }
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    /* not created yet; the lexical check below still applies */
  }
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

// ── composer / studio state ───────────────────────────────────────────────

function statePath() {
  return path.join(STATE_DIR, STATE_FILENAME);
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
    return true;
  } catch (err) {
    console.error('[web] failed to write', STATE_FILENAME, err);
    return false;
  }
}

// ── claw-gen resolution (mirrors main.js resolvePipelineCli) ──────────────

function findOnPath(exeName) {
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, exeName + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function pipelineSettingsPath() {
  return path.join(STATE_DIR, 'pipeline-settings.json');
}

function resolvePipelineCli() {
  // Same order as main.js (user setting → PATH), with an env override first so
  // a systemd/launchd unit can point at a venv without editing a JSON file.
  const fromEnv = process.env.CLAWSCAD_CLI || args.cli;
  if (fromEnv) {
    try {
      if (fs.statSync(fromEnv).isFile()) return fromEnv;
    } catch {}
  }
  try {
    const settings = JSON.parse(fs.readFileSync(pipelineSettingsPath(), 'utf-8'));
    if (settings.cliPath && fs.statSync(settings.cliPath).isFile()) return settings.cliPath;
  } catch {}
  return findOnPath('claw-gen');
}

function resolveClaude() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) candidates.push(path.join(dir, 'claude'));
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const c of candidates) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(c + ext)) return c + ext;
      } catch {}
    }
  }
  return null;
}

// ── SSE fan-out ───────────────────────────────────────────────────────────
//
// One event stream per connected browser. The pipeline child is per-SERVER
// (mirroring Electron's one-child-per-window), so every connected client sees
// every event — which is the honest behaviour for a single-user self-host and
// is stated in the README rather than pretended away.

const sseClients = new Set();

function sseSend(channel, data) {
  const payload = `data: ${JSON.stringify({ channel, data })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Cloudflare and any nginx in front will otherwise buffer the stream and
    // deliver ten minutes of pipeline events in one burst at the end.
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ channel: 'hello', data: { version: PKG_VERSION } })}\n\n`);
  sseClients.add(res);

  // A tunnel drops an idle connection long before a 10-minute mesh emits its
  // next event; the comment keeps the socket warm without being an event.
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

// ── pipeline (mirrors main.js startPipelineAction, and then goes further) ──
//
// The desktop app chains mesh → prep → checkpoint from renderer.js, off a
// `genPendingStage` variable that lives in the RENDERER. That survives in
// Electron, where the renderer IS the app — close the window and there is no
// run left to strand.
//
// It does not survive a browser. On 2026-08-30 a real generation finished its
// images and a watertight 516K-vertex mesh and then stopped, `prep` and
// `checkpoint` still pending, because the tab had closed during the ~10-minute
// mesh and nothing was left to fire the next stage. Ten minutes of GPU work sat
// finished on disk with no checkpoint, and nothing on screen said so.
//
// So the chain lives HERE. The client declares its intent once — `chain` on the
// head stage — and the server carries it to the end whether or not anybody is
// still listening. sseSend to zero clients is a no-op, not an error, which is
// the whole reason this works.

let pipelineChild = null;
let pipelineJobDir = null;
// The stage in flight and the stages still owed after it, plus the job slug
// that ties them together. All three are per-server, like pipelineChild.
let pipelineAction = null;
let pipelineChain = [];
let pipelineJob = null;

function pipelineErrorEvent(stage, code, message) {
  return { v: 1, ts: new Date().toISOString(), stage, event: 'error', code, message, job: '' };
}

/**
 * `chain` arrives off the network, so it is validated rather than trusted.
 * Bounded, unique, and never re-entering the head stage — `['mesh','mesh',…]`
 * would otherwise be a self-restarting GPU job with no button to stop it.
 */
function normalizeChain(head, chain) {
  if (chain === undefined || chain === null) return { chain: [] };
  if (!Array.isArray(chain)) return { error: 'bad-chain' };
  const out = chain.map(String);
  if (out.length > PIPELINE_ACTIONS.size - 1) return { error: 'bad-chain' };
  if (new Set(out).size !== out.length) return { error: 'bad-chain' };
  if (out.some((a) => a === head || !PIPELINE_ACTIONS.has(a))) return { error: 'bad-chain' };
  return { chain: out };
}

function startPipelineAction({ action, args: rawArgs = [], job, chain } = {}) {
  if (pipelineChild) return { error: 'already-running' };
  if (!PIPELINE_ACTIONS.has(action)) return { error: 'bad-action' };
  if (!Array.isArray(rawArgs)) return { error: 'bad-args' };
  const normalized = normalizeChain(action, chain);
  if (normalized.error) return { error: normalized.error };

  pipelineChain = normalized.chain;
  pipelineJob = job ? String(job) : null;
  const result = spawnPipelineStage(action, rawArgs.map(String), pipelineJob);
  // A head stage that never started owes nothing; leaving the chain armed would
  // make the NEXT unrelated run inherit it.
  if (result.error) pipelineChain = [];
  return result;
}

function spawnPipelineStage(action, argsList, job) {
  const cli = resolvePipelineCli();
  if (!cli) {
    sseSend('pipeline:event', pipelineErrorEvent(action, 'not-configured', 'No generation pipeline configured'));
    return { error: 'not-configured' };
  }

  const argv = [action, ...argsList, '--json-events'];
  if (job) argv.push('--job', String(job));

  let child;
  try {
    // Array argv, never a shell string: everything in `args` came off the
    // network and a shell would make `; rm -rf` an argument value.
    child = spawn(cli, argv, { cwd: WORKSPACE, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    sseSend('pipeline:event', pipelineErrorEvent(action, 'spawn-failed', err.message));
    return { error: err.message };
  }

  pipelineChild = child;
  pipelineAction = action;
  let stdoutBuf = '';

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      // The slug comes from the CLI's own events, never from the model or the
      // client: a continuation stage aimed at the wrong job would prep and
      // checkpoint somebody else's mesh.
      if (typeof evt.job === 'string' && evt.job) pipelineJob = evt.job;
      // job dir is two levels up from img/<file> — same derivation as main.js,
      // and it is what narrows an image read below the whole workspace.
      if (evt.event === 'candidate' && typeof evt.path === 'string') {
        pipelineJobDir = path.dirname(path.dirname(path.resolve(WORKSPACE, evt.path)));
      }
      sseSend('pipeline:event', evt);
    }
  });

  child.stderr.on('data', (chunk) => sseSend('pipeline:log', chunk.toString()));

  child.on('error', (err) => {
    pipelineChild = null;
    pipelineAction = null;
    pipelineChain = [];
    sseSend('pipeline:event', pipelineErrorEvent(action, 'spawn-failed', err.message));
    sseSend('pipeline:exit', { action, code: null, chained: null });
  });

  child.on('exit', (code) => {
    pipelineChild = null;
    pipelineAction = null;
    // Only a CLEAN exit advances. A failed mesh must not be prepped: prep would
    // run against a half-written or absent .stl and report its own, less useful
    // error on top of the real one — and a cancelled run must stay cancelled.
    const next = code === 0 ? pipelineChain.shift() || null : null;
    if (!next) pipelineChain = [];
    // `chained` is what tells a listening client the run is NOT over, so it
    // keeps its controls locked instead of re-enabling between stages.
    sseSend('pipeline:exit', { action, code, chained: next });
    if (next) {
      // Continuation stages take no positional args; the job slug is what
      // carries the context forward.
      const started = spawnPipelineStage(next, [], pipelineJob);
      if (started.error) {
        pipelineChain = [];
        sseSend('pipeline:exit', { action: next, code: null, chained: null });
      }
    }
  });

  return { started: true };
}

// ── checkpoint reconcile (READ-ONLY) ──────────────────────────────────────
//
// main.js has reconcileWorkspace(), which adopts `.scad` files that exist on
// disk but are missing from the registry. Its comment says why: the watcher
// starts with `ignoreInitial: true`, so anything created while the app was
// closed "was invisible forever", and for a tool whose whole promise is that
// every file is a permanent checkpoint you can come back to, silently omitting
// real work is the worst failure available.
//
// The web port has no watcher AND no reconcile, so the failure is not merely
// possible here, it is the DEFAULT: `claw-gen checkpoint` — which is exactly
// what the server-side chain now ends with — writes the .scad and nobody
// writes the registry. The 2026-08-30 cheese-man sculpt sat finished on disk,
// with a 3MF and a render beside it, and the browser listed nothing.
//
// This adopts in MEMORY and never writes. clawscad.json belongs to the desktop
// app (design rule 4 at the top of this file), and a second writer on a shared
// JSON is precisely the composer-state.json bug this release already paid for.
// The desktop's own reconcile still does the durable write the next time it
// opens; until then the browser at least tells the truth about what exists.
const ACTIVE_FILE = 'active.scad';

function reconcileCheckpoints(registered) {
  const out = { ...registered };
  let files;
  try {
    files = fs.readdirSync(WORKSPACE).filter((f) => f.endsWith('.scad') && f !== ACTIVE_FILE);
  } catch {
    return out;
  }

  const known = new Set(Object.values(out).map((c) => c && c.file));
  const missing = files
    .filter((f) => !known.has(f))
    .map((f) => {
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(WORKSPACE, f)).mtimeMs;
      } catch {}
      return { file: f, mtime };
    })
    // Oldest first, so the adopted chain reads in the order the work was done —
    // same ordering rule as main.js, for the same reason.
    .sort((a, b) => a.mtime - b.mtime);

  for (const m of missing) {
    // Derived from the filename, not random: this id is regenerated on every
    // request and must be stable across them, or the recent list would reorder
    // itself on each poll. It is namespaced so it can never collide with a
    // real registry id, which is what the desktop app will eventually assign.
    const id = `web_adopted_${m.file.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
    out[id] = {
      file: m.file,
      parent: null,
      label: path.basename(m.file, '.scad').replace(/[_-]/g, ' ').substring(0, 30),
      // mtime, not now — an adopted file's real age is what makes the list honest.
      created: new Date(m.mtime || Date.now()).toISOString(),
      discovered: true,
    };
  }
  return out;
}

function pipelineStatus() {
  return {
    running: Boolean(pipelineChild),
    action: pipelineAction,
    job: pipelineJob,
    chain: [...pipelineChain],
  };
}

function pipelineBackends() {
  const cli = resolvePipelineCli();
  if (!cli) return Promise.resolve({ configured: false, state: 'not-found' });
  return new Promise((resolve) => {
    execFile(cli, ['backends', '--json'], { cwd: WORKSPACE, timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      let parsed = null;
      try {
        const lines = (stdout || '').trim().split('\n').filter(Boolean);
        parsed = JSON.parse(lines[lines.length - 1]);
      } catch {}
      if (!parsed) {
        resolve({
          configured: false,
          state: 'cli-error',
          cli,
          detail: (stderr || (err && err.message) || 'claw-gen produced no parsable output').trim(),
        });
        return;
      }
      parsed.cli = cli;
      if (parsed.configured) {
        const images = (parsed.backends || []).filter((b) => !b.kind || b.kind === 'image');
        parsed.state = images.some((b) => b.ok) ? 'ready' : 'no-backend';
      } else {
        parsed.state = parsed.state || 'not-configured';
      }
      resolve(parsed);
    });
  });
}

// ── uploads ───────────────────────────────────────────────────────────────
//
// main/uploads.js's ingestBuffer() is not exported (only `_internal`'s
// storeUnique/kebabCase are), and its mesh and .scad branches both end in
// deps.addCheckpoint(ctx, …) — a function that only exists inside the Electron
// main process, because a checkpoint is a registry write plus a watcher plus a
// render. So the image branch is reproduced here on top of the SAME
// storeUnique (hash-on-collision, never overwrite, size-verified after write),
// and the other two classes refuse with a stated reason rather than half-doing
// it. The Studio only ever accepts `class === 'image'` anyway.

function uploadsManifestPath() {
  return path.join(WORKSPACE, 'uploads', 'uploads.json');
}

function readUploadsManifest() {
  try {
    const data = JSON.parse(fs.readFileSync(uploadsManifestPath(), 'utf-8'));
    if (Array.isArray(data.files)) return data;
  } catch {}
  return { files: [] };
}

function writeUploadsManifestEntry(entry) {
  fs.mkdirSync(path.join(WORKSPACE, 'uploads'), { recursive: true });
  const manifest = readUploadsManifest();
  const idx = manifest.files.findIndex((f) => f.file === entry.file);
  if (idx >= 0) manifest.files[idx] = entry;
  else manifest.files.push(entry);
  fs.writeFileSync(uploadsManifestPath(), JSON.stringify(manifest, null, 2));
}

function ingestImageBytes(buffer, rawName) {
  // path.basename first: a browser can put anything in the filename field, and
  // "../../.ssh/authorized_keys.png" must become "authorized_keys.png".
  const name = path.basename(String(rawName || 'upload'));
  const ext = path.extname(name).toLowerCase();

  if (buffer.length > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      class: 'blocked',
      name,
      ext,
      message: `\`${name}\` is ${(buffer.length / (1024 * 1024)).toFixed(0)} MB — larger than ClawSCAD's ${
        MAX_UPLOAD_BYTES / (1024 * 1024)
      } MB upload cap.`,
    };
  }
  if (UPLOAD_MESH_EXTS.includes(ext) || ext === '.scad') {
    return {
      ok: false,
      class: ext === '.scad' ? 'scad' : 'mesh',
      name,
      ext,
      message:
        `\`${name}\` imports as a checkpoint, and creating checkpoints needs the desktop app — ` +
        `the browser port has no checkpoint registry, watcher or renderer. Open it in ClawSCAD on the desktop.`,
    };
  }
  if (!UPLOAD_IMAGE_EXTS.includes(ext)) {
    return {
      ok: false,
      class: 'blocked',
      name,
      ext,
      message: `ClawSCAD doesn't recognise "${ext || name}". Supported here: png, jpg, webp, svg, dxf.`,
    };
  }

  const baseSlug = uploadInternals.kebabCase(path.basename(name, ext), 40);
  const dateSlug = new Date().toISOString().slice(0, 10);
  const stored = uploadInternals.storeUnique(path.join(WORKSPACE, 'uploads'), `${dateSlug}-${baseSlug}`, ext, buffer);
  const relPath = 'uploads/' + stored.name;

  writeUploadsManifestEntry({
    file: relPath,
    sha256: stored.sha256,
    bytes: stored.bytes,
    originalPath: null,
    importedAt: new Date().toISOString(),
    kind: 'image',
  });

  const warnings = [];
  if (ext === '.svg') {
    const head = buffer.slice(0, Math.min(buffer.length, 200000)).toString('utf-8');
    if (/<text[\s>]/i.test(head)) {
      warnings.push(
        'This SVG contains live <text> — OpenSCAD imports it as an empty object. Convert text to ' +
          'paths (Object to Path / Create Outlines / Flatten) before it will render.'
      );
    }
  }

  return { ok: true, class: 'image', name, ext, relPath, dedup: stored.dedup, warnings };
}

// ── Flow A: headless Claude ───────────────────────────────────────────────
//
// The desktop app writes the brief into a live Claude Code pty. There is no pty
// in a browser — but Flow A never actually needed one. `claude -p` is print
// mode: it runs headless, does the work, and exits. That is the whole fix.
//
// --permission-mode acceptEdits is load-bearing. A headless run that hits a
// permission prompt has no one to answer it and blocks until the timeout, which
// to the user is indistinguishable from a hang. acceptEdits lets it write the
// .scad it was asked for without opening the door to everything else.

let makeChild = null;
let makeStartedAt = 0;
const MAKE_TIMEOUT_MS = 10 * 60 * 1000;

/** Snapshot every .scad in the workspace with its mtime + size. */
function scadSnapshot() {
  const out = new Map();
  try {
    for (const name of fs.readdirSync(WORKSPACE)) {
      if (!name.toLowerCase().endsWith('.scad')) continue;
      try {
        const st = fs.statSync(path.join(WORKSPACE, name));
        out.set(name, `${st.mtimeMs}:${st.size}`);
      } catch {}
    }
  } catch {}
  return out;
}

/** What changed between two snapshots — new files first, then modified. */
function scadDelta(before, after) {
  const created = [];
  const modified = [];
  for (const [name, sig] of after) {
    if (!before.has(name)) created.push(name);
    else if (before.get(name) !== sig) modified.push(name);
  }
  return { created, modified };
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

function startMake({ brief } = {}) {
  if (makeChild) return { error: 'already-running', startedAt: makeStartedAt };
  const text = typeof brief === 'string' ? brief.trim() : '';
  if (!text) return { error: 'no-brief' };

  const claude = resolveClaude();
  if (!claude) {
    return {
      error: 'not-configured',
      reason: 'The Claude Code CLI was not found on this machine, so nothing can build the model.',
    };
  }

  const before = scadSnapshot();
  const startedAt = Date.now();
  makeStartedAt = startedAt;

  let child;
  try {
    child = spawn(claude, ['-p', text, '--permission-mode', 'acceptEdits', '--output-format', 'text'], {
      cwd: WORKSPACE,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows has no process groups to signal; killTree shells out instead.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch (err) {
    return { error: 'spawn-failed', reason: String((err && err.message) || err) };
  }

  makeChild = child;
  sseSend('make:event', { event: 'start', startedAt });

  child.stdout.on('data', (c) => sseSend('make:log', c.toString()));
  child.stderr.on('data', (c) => sseSend('make:log', c.toString()));

  const timer = setTimeout(() => {
    sseSend('make:event', { event: 'timeout', elapsedMs: Date.now() - startedAt });
    killTree(child);
  }, MAKE_TIMEOUT_MS);
  timer.unref?.();

  const finish = (code) => {
    clearTimeout(timer);
    makeChild = null;
    // Do NOT trust the model to report a path — diff the directory.
    const delta = scadDelta(before, scadSnapshot());
    const file = delta.created[0] || delta.modified[0] || null;
    sseSend('make:event', {
      event: 'done',
      code,
      elapsedMs: Date.now() - startedAt,
      file,
      created: delta.created,
      modified: delta.modified,
    });
  };

  child.on('error', (err) => {
    clearTimeout(timer);
    makeChild = null;
    sseSend('make:event', { event: 'error', reason: String((err && err.message) || err) });
  });
  child.on('exit', finish);

  return { started: true, startedAt };
}

// ── models: list, params, render, export ──────────────────────────────────

const OPENSCAD_EXPORT = new Map([
  ['3mf', { ext: '.3mf', mime: 'model/3mf' }],
  ['stl', { ext: '.stl', mime: 'model/stl' }],
  ['png', { ext: '.png', mime: 'image/png' }],
]);

function resolveOpenscad() {
  const explicit = args.openscad || process.env.OPENSCAD_BINARY;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const guesses =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\OpenSCAD (Nightly)\\openscad.com',
          'C:\\Program Files\\OpenSCAD\\openscad.com',
          'C:\\Program Files\\OpenSCAD\\openscad.exe',
        ]
      : ['/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD', '/usr/bin/openscad', '/usr/local/bin/openscad'];
  for (const g of guesses) {
    try {
      if (fs.existsSync(g)) return g;
    } catch {}
  }
  return findOnPath('openscad');
}

/** Every .scad in the workspace, newest first — so a model made a minute ago
 *  is the first thing offered. `active.scad` is excluded: it is a COPY the
 *  desktop app maintains, not a model in its own right. */
function listModels() {
  const out = [];
  try {
    for (const name of fs.readdirSync(WORKSPACE)) {
      if (!name.toLowerCase().endsWith('.scad')) continue;
      if (name.toLowerCase() === 'active.scad') continue;
      try {
        const st = fs.statSync(path.join(WORKSPACE, name));
        out.push({ file: name, bytes: st.size, modified: st.mtimeMs });
      } catch {}
    }
  } catch {}
  out.sort((a, b) => b.modified - a.modified);
  return out;
}

/** Run OpenSCAD to `outPath` with `-D` overrides. Resolves { ok, error }. */
function runOpenscad({ scadPath, outPath, defines, extraArgs = [] }) {
  return new Promise((resolve) => {
    const bin = resolveOpenscad();
    if (!bin) {
      return resolve({
        ok: false,
        error:
          'OpenSCAD was not found on this machine, so nothing can render or export. ' +
          'Install it, or start the server with --openscad <path>.',
      });
    }
    const argv = ['-o', outPath, ...extraArgs, ...defines, scadPath];
    let child;
    try {
      child = spawn(bin, argv, { cwd: WORKSPACE, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, error: String((err && err.message) || err) });
    }
    let stderr = '';
    child.stderr.on('data', (c) => {
      if (stderr.length < 8000) stderr += c.toString();
    });
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => killTree(child), 5 * 60 * 1000);
    timer.unref?.();
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String((err && err.message) || err) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      // OpenSCAD can exit 0 having written nothing (an empty top-level), so the
      // artifact is what decides success, not the code. Same rule the desktop
      // app learned: assert the artifact.
      let exists = false;
      let size = 0;
      try {
        const st = fs.statSync(outPath);
        exists = st.isFile();
        size = st.size;
      } catch {}
      if (!exists || size === 0) {
        return resolve({
          ok: false,
          code,
          error: stderr.trim() || `OpenSCAD exited ${code} without producing a file.`,
        });
      }
      resolve({ ok: true, code, size, warnings: stderr.trim() || null });
    });
  });
}

/** Read a model's source and parse its customizer parameters. */
function modelParams(file) {
  const resolved = containedInWorkspace(file);
  if (!resolved || !resolved.toLowerCase().endsWith('.scad')) {
    return { ok: false, error: 'That is not a .scad file inside this workspace.' };
  }
  let src;
  try {
    src = fs.readFileSync(resolved, 'utf-8');
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  const parsed = parseScadParams(src);
  return { ok: true, file: path.relative(WORKSPACE, resolved).replace(/\\/g, '/'), ...parsed };
}

/** Where renders land. Inside the workspace on purpose: the containment check
 *  is the security boundary and a temp dir outside it could not be served. */
function renderDir() {
  const dir = path.join(WORKSPACE, 'renders', 'web');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

async function renderModel({ file, values, format }) {
  const info = modelParams(file);
  if (!info.ok) return info;
  const fmt = OPENSCAD_EXPORT.get(String(format || 'png').toLowerCase());
  if (!fmt) return { ok: false, error: `Unsupported format: ${format}` };

  const scadPath = containedInWorkspace(file);
  const base = path.basename(scadPath, path.extname(scadPath));
  // One output per {model, format} — a preview overwrites its predecessor
  // rather than filling the disk with every keystroke's render.
  const outPath = path.join(renderDir(), `${base}${fmt.ext}`);

  const defines = buildDefineArgs(info.parameters, values || {});
  const extra = [];
  if (fmt.ext === '.png') {
    extra.push('--imgsize=900,700', '--colorscheme=Tomorrow Night', '--viewall', '--autocenter');
  } else {
    // Manifold is dramatically faster and is what the desktop export uses.
    extra.push('--backend=Manifold');
    if (fmt.ext === '.3mf') extra.push('--export-format', '3mf');
  }

  const result = await runOpenscad({ scadPath, outPath, defines, extraArgs: extra });
  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  return {
    ok: true,
    path: path.relative(WORKSPACE, outPath).replace(/\\/g, '/'),
    bytes: result.size,
    warnings: result.warnings,
    defines: defines.filter((a) => a !== '-D'),
  };
}

// ── the Workbench's mesh: find one, or make one ───────────────────────────
//
// The desktop app renders on every save through a local OpenSCAD process and
// keeps the result beside the .scad. The browser cannot run that process, but
// the SERVER can — it already does, for Customize — so the browser Workbench
// asks for "a mesh for this checkpoint" and this decides how to answer:
//
//  1. a sibling .3mf or .stl the desktop app already wrote (free, and 3MF
//     first because a 2.6 MB 3MF and a 109 MB STL are routinely the same
//     model — the small one is the only one a phone can parse);
//  2. a render this server made earlier and that is still newer than its
//     source (the .scad is the only input, so mtime is a sufficient test);
//  3. a fresh OpenSCAD run.
//
// One in-flight promise per file: two tabs, or a phone and a laptop, asking for
// the same model must not start two five-minute renders of it.

const MESH_EXTS = ['.3mf', '.stl'];
const meshInFlight = new Map();

function relToWorkspace(abs) {
  return path.relative(WORKSPACE, abs).replace(/\\/g, '/');
}

function statFile(candidate) {
  try {
    const st = fs.statSync(candidate);
    return st.isFile() && st.size > 0 ? st : null;
  } catch {
    return null;
  }
}

/** 'environment' (nothing to render WITH), 'timeout', or 'model' (the .scad
 *  itself). Same three-way split main.js classifies render failures into, and
 *  the Workbench says a different sentence for each. */
function classifyMeshError(error) {
  const text = String(error || '');
  if (/OpenSCAD was not found/i.test(text) || /ENOENT/.test(text)) return 'environment';
  if (/timed out|SIGTERM|killed/i.test(text)) return 'timeout';
  return 'model';
}

async function ensureMesh(file) {
  const scadPath = containedInWorkspace(file);
  if (!scadPath || !scadPath.toLowerCase().endsWith('.scad')) {
    return { ok: false, error: 'That is not a .scad file inside this workspace.', fault: 'model' };
  }
  const source = statFile(scadPath);
  if (!source) return { ok: false, error: 'That model is not on disk any more.', fault: 'model' };

  const dir = path.dirname(scadPath);
  const base = path.basename(scadPath, path.extname(scadPath));

  for (const ext of MESH_EXTS) {
    const st = statFile(path.join(dir, base + ext));
    if (st) return { ok: true, path: relToWorkspace(path.join(dir, base + ext)), format: ext.slice(1), bytes: st.size, cached: true };
  }
  for (const ext of MESH_EXTS) {
    const cached = path.join(renderDir(), base + ext);
    const st = statFile(cached);
    if (st && st.mtimeMs >= source.mtimeMs) {
      return { ok: true, path: relToWorkspace(cached), format: ext.slice(1), bytes: st.size, cached: true };
    }
  }

  const key = scadPath.toLowerCase();
  if (meshInFlight.has(key)) return meshInFlight.get(key);

  const job = (async () => {
    sseSend('render:event', { event: 'start', file: relToWorkspace(scadPath) });
    // 3MF first for the same reason as above; STL is the fallback because some
    // OpenSCAD builds refuse `--export-format 3mf` outright, and a model the
    // user can see as a big STL beats a stated reason.
    let last = null;
    for (const ext of MESH_EXTS) {
      const outPath = path.join(renderDir(), base + ext);
      const extra = ['--backend=Manifold'];
      if (ext === '.3mf') extra.push('--export-format', '3mf');
      const result = await runOpenscad({ scadPath, outPath, defines: [], extraArgs: extra });
      if (result.ok) {
        const out = { ok: true, path: relToWorkspace(outPath), format: ext.slice(1), bytes: result.size, cached: false };
        sseSend('render:event', { event: 'complete', file: relToWorkspace(scadPath), format: out.format, bytes: out.bytes });
        return out;
      }
      last = result;
      if (classifyMeshError(result.error) !== 'model') break; // no binary / timeout: a second attempt cannot help
    }
    const fault = classifyMeshError(last && last.error);
    const out = { ok: false, error: (last && last.error) || 'OpenSCAD produced nothing.', fault };
    sseSend('render:event', { event: 'error', file: relToWorkspace(scadPath), error: out.error, fault });
    return out;
  })();

  meshInFlight.set(key, job);
  try {
    return await job;
  } finally {
    meshInFlight.delete(key);
  }
}

/** The registry id the browser holds → the file it names. The Studio's recent
 *  list passes an id and nothing else (studio.js:1836), and the reconciled view
 *  is the only place an adopted `web_adopted_*` id exists at all. */
function checkpointFileForId(id) {
  if (typeof id !== 'string' || !id) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(WORKSPACE, CHECKPOINT_REGISTRY), 'utf-8'));
  } catch {}
  const all = reconcileCheckpoints((parsed && parsed.checkpoints) || {});
  const entry = all[id];
  return entry && typeof entry.file === 'string' ? entry.file : null;
}

/**
 * Copy a checkpoint's .scad over `active.scad`, which is what "open this one"
 * means to everything else in the workspace: it is the file CLAUDE.md points
 * Claude at. It is deliberately NOT a registry write — clawscad.json stays the
 * desktop app's file (design rule 4) — and the desktop watcher ignores
 * active.scad, so this cannot bounce back as a phantom checkpoint.
 */
function selectCheckpoint({ id, file }) {
  const wanted = (typeof file === 'string' && file) || checkpointFileForId(id);
  if (!wanted) return { ok: false, error: 'No checkpoint by that id.' };
  const resolved = containedInWorkspace(wanted);
  if (!resolved || !resolved.toLowerCase().endsWith('.scad')) {
    return { ok: false, error: 'That is not a .scad file inside this workspace.' };
  }
  if (path.basename(resolved).toLowerCase() === ACTIVE_FILE) {
    return { ok: false, error: 'active.scad is the working copy, not a checkpoint.' };
  }
  let source;
  try {
    source = fs.readFileSync(resolved, 'utf-8');
    fs.copyFileSync(resolved, path.join(WORKSPACE, ACTIVE_FILE));
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  return { ok: true, file: relToWorkspace(resolved), source };
}

// ── http helpers ──────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const text = JSON.stringify(body === undefined ? null : body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req, MAX_JSON_BYTES);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf-8'));
}

function serveStatic(res, entry) {
  fs.readFile(entry.file, (err, data) => {
    if (err) {
      sendJson(res, 404, {
        error: 'not-found',
        detail: `${path.basename(entry.file)} is missing. Run \`node web/build.js\` to produce web/dist/app.js.`,
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Content-Length': data.length,
      // The bundle changes on every build and there is no hash in the URL, so
      // a stale cached app.js would be a "why is my fix not live" afternoon.
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function serveWorkspaceImage(req, res, requested) {
  const resolved = containedInWorkspace(requested);
  if (!resolved) return sendJson(res, 403, { error: 'outside-workspace' });

  // Second gate, mirroring main.js: once a job dir is known, an image read is
  // narrowed to it. Workspace containment alone would let any png in the tree
  // be read; this is the same restriction the desktop app applies.
  //
  // It has TWO legitimate roots, not one. customize.js loads its preview from
  // `renders/web/<model>.png`, and this server wrote that file itself — it is
  // not a location the client chose. With only the job root, a single image
  // generation 403'd every Customize preview for the LIFE OF THE PROCESS
  // (`pipelineJobDir` is never cleared), and it did it silently: the note said
  // "Rendered" and the <img> stayed empty. That is survivable in Electron,
  // where the window is restarted constantly; this server runs for days behind
  // a tunnel. Widened, not removed — an unrelated path in the tree is still
  // refused, which is the property the gate exists for.
  if (pipelineJobDir) {
    const roots = [path.resolve(pipelineJobDir), path.resolve(renderDir())];
    const insideOne = roots.some((root) => {
      const rel = path.relative(root, resolved);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!insideOne) return sendJson(res, 403, { error: 'outside-job-dir' });
  }

  const ext = path.extname(resolved).toLowerCase();
  if (!PIPELINE_IMAGE_EXTS.has(ext)) return sendJson(res, 415, { error: 'not-an-image' });

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return sendJson(res, 404, { error: 'not-found' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'not-a-file' });
  if (stat.size > PIPELINE_MAX_IMAGE_BYTES) return sendJson(res, 413, { error: 'too-large' });

  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(resolved).pipe(res);
}

// ── routes ────────────────────────────────────────────────────────────────

async function route(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === '/events' && method === 'GET') return openStream(req, res);

  // ── tools:load / categories:load — through the extracted loaders ────────
  if (p === '/api/tools' && method === 'GET') return sendJson(res, 200, loadTools(STATE_DIR));
  if (p === '/api/categories' && method === 'GET') return sendJson(res, 200, loadCategories(STATE_DIR));

  if (p === '/api/workspace' && method === 'GET') {
    return sendJson(res, 200, { workspace: WORKSPACE, stateDir: STATE_DIR, version: PKG_VERSION });
  }

  // ── env:status ──────────────────────────────────────────────────────────
  if (p === '/api/env' && method === 'GET') {
    // Honest, server-side probes — and honest is the whole point, so this has
    // to keep up with what the port can actually do. It said `viewport:false,
    // render:false` for a release after Customize started rendering through
    // OpenSCAD on this very machine, and it now has a browser Workbench with a
    // three.js viewport in it. The terminal is the one that stays false.
    const openscad = resolveOpenscad();
    return sendJson(res, 200, {
      openscad: openscad ? { binary: openscad } : null,
      claude: { binary: resolveClaude() },
      clawGen: { binary: resolvePipelineCli() },
      web: {
        terminal: false,
        viewport: true,
        render: Boolean(openscad),
        reason: 'There is no terminal in the browser port — Ask Claude in the Workbench runs headless instead.',
      },
    });
  }

  // ── composer:get-state / composer:set-state ─────────────────────────────
  if (p === '/api/composer/state' && method === 'GET') return sendJson(res, 200, readState());

  if (p === '/api/composer/state' && method === 'POST') {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, false);
    // mergeState is imported, not reimplemented: top-level merge, and `{}`
    // clears the file. Both halves are load-bearing (main/composer.js).
    return sendJson(res, 200, writeState(mergeState(readState(), body)));
  }

  // ── composer:send-to-claude — Flow A, headless ──────────────────────────
  // This used to 501 ("no pty in a browser"). It never needed one: `claude -p`
  // runs headless and exits. The Studio's normal Flow A path now fires here.
  if (p === '/api/composer/send-to-claude' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => ({}));
    const brief = body && (body.message || body.brief);
    const started = startMake({ brief });
    if (started.error) {
      const status = started.error === 'already-running' ? 409 : started.error === 'no-brief' ? 400 : 503;
      return sendJson(res, status, { ok: false, ...started });
    }
    return sendJson(res, 200, { ok: true, ...started });
  }

  if (p === '/api/make/cancel' && method === 'POST') {
    if (!makeChild) return sendJson(res, 200, { ok: false, reason: 'nothing running' });
    killTree(makeChild);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/make/status' && method === 'GET') {
    return sendJson(res, 200, {
      running: Boolean(makeChild),
      startedAt: makeChild ? makeStartedAt : null,
      claude: resolveClaude(),
    });
  }

  // ── models: list / params / render / export ─────────────────────────────
  if (p === '/api/models' && method === 'GET') return sendJson(res, 200, { models: listModels() });

  if (p === '/api/model/params' && method === 'GET') {
    const info = modelParams(url.searchParams.get('file') || '');
    return sendJson(res, info.ok ? 200 : 400, info);
  }

  if (p === '/api/model/source' && method === 'GET') {
    const resolved = containedInWorkspace(url.searchParams.get('file') || '');
    if (!resolved || !resolved.toLowerCase().endsWith('.scad')) {
      return sendJson(res, 403, { ok: false, error: 'outside the workspace' });
    }
    try {
      return sendJson(res, 200, { ok: true, source: fs.readFileSync(resolved, 'utf-8') });
    } catch (err) {
      return sendJson(res, 404, { ok: false, error: String((err && err.message) || err) });
    }
  }

  if ((p === '/api/model/preview' || p === '/api/model/export') && method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) || {};
    const format = p.endsWith('preview') ? 'png' : String(body.format || '3mf').toLowerCase();
    const out = await renderModel({ file: body.file, values: body.values, format });
    return sendJson(res, out.ok ? 200 : 400, out);
  }

  // Serve a rendered artifact for download. Same containment check as images —
  // this is a file read driven by a query parameter and gets no exemption.
  if (p === '/api/model/download' && (method === 'GET' || method === 'HEAD')) {
    const requested = url.searchParams.get('path') || '';
    const resolved = containedInWorkspace(requested);
    if (!resolved) return sendJson(res, 403, { error: 'outside the workspace' });
    const ext = path.extname(resolved).toLowerCase();
    const kind = [...OPENSCAD_EXPORT.values()].find((v) => v.ext === ext);
    if (!kind) return sendJson(res, 415, { error: `not a downloadable artifact: ${ext}` });
    let st;
    try {
      st = fs.statSync(resolved);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      return sendJson(res, 404, { error: 'not found' });
    }
    res.writeHead(200, {
      'Content-Type': kind.mime,
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${path.basename(resolved)}"`,
      'Cache-Control': 'no-store',
    });
    if (method === 'HEAD') return res.end();
    return fs.createReadStream(resolved).pipe(res);
  }

  // ── pipeline ────────────────────────────────────────────────────────────
  if (p === '/api/pipeline/backends' && method === 'GET') return sendJson(res, 200, await pipelineBackends());

  if (p === '/api/pipeline/start' && method === 'POST') {
    const body = await readJsonBody(req);
    return sendJson(res, 200, startPipelineAction(body || {}));
  }

  if (p === '/api/pipeline/status' && method === 'GET') return sendJson(res, 200, pipelineStatus());

  if (p === '/api/pipeline/cancel' && method === 'POST') {
    if (!pipelineChild) return sendJson(res, 200, false);
    // Disarm BEFORE killing. Cancel means the whole run, not just the stage in
    // flight; a surviving chain would start prep on the mesh the user just
    // stopped. (The exit handler also refuses to advance on a non-zero code —
    // this is the belt to that's braces, because a kill can race a clean exit.)
    pipelineChain = [];
    try {
      pipelineChild.kill('SIGTERM');
      return sendJson(res, 200, true);
    } catch {
      return sendJson(res, 200, false);
    }
  }

  if (p === '/api/pipeline/image' && (method === 'GET' || method === 'HEAD')) {
    return serveWorkspaceImage(req, res, url.searchParams.get('path') || '');
  }

  // ── uploads ─────────────────────────────────────────────────────────────
  if (p === '/api/upload/ingest-bytes' && method === 'POST') {
    const name = url.searchParams.get('name') || req.headers['x-filename'] || 'upload';
    let buf;
    try {
      buf = await readBody(req, MAX_UPLOAD_BYTES);
    } catch (err) {
      return sendJson(res, err.status || 400, { ok: false, error: 'That file is too large to upload.' });
    }
    try {
      return sendJson(res, 200, ingestImageBytes(buf, name));
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: String((err && err.message) || err) });
    }
  }

  if (p === '/api/upload/list' && method === 'GET') return sendJson(res, 200, readUploadsManifest());

  // ── checkpoints (READ ONLY — clawscad.json belongs to the desktop app) ──
  if (p === '/api/checkpoints' && method === 'GET') {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(WORKSPACE, CHECKPOINT_REGISTRY), 'utf-8'));
    } catch {}
    return sendJson(res, 200, {
      checkpoints: reconcileCheckpoints((parsed && parsed.checkpoints) || {}),
      active: (parsed && parsed.active) || null,
    });
  }

  // ── the Workbench ───────────────────────────────────────────────────────
  //
  // Three routes, and between them the browser Workbench can do what the
  // desktop one does with a checkpoint: open it, see it, and take it away.

  if (p === '/api/checkpoint/select' && method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) || {};
    const out = selectCheckpoint({ id: body.id, file: body.file });
    return sendJson(res, out.ok ? 200 : 400, out);
  }

  if (p === '/api/checkpoint/mesh' && method === 'GET') {
    const out = await ensureMesh(url.searchParams.get('file') || '');
    return sendJson(res, out.ok ? 200 : 400, out);
  }

  // Inline mesh bytes, for the three.js loaders. /api/model/download stays the
  // attachment route Customize uses; a mesh the viewport is about to parse must
  // not arrive as a download the phone offers to save.
  if (p === '/api/model/file' && (method === 'GET' || method === 'HEAD')) {
    const resolved = containedInWorkspace(url.searchParams.get('path') || '');
    if (!resolved) return sendJson(res, 403, { error: 'outside the workspace' });
    const ext = path.extname(resolved).toLowerCase();
    if (!MESH_EXTS.includes(ext)) return sendJson(res, 415, { error: `not a mesh: ${ext}` });
    const st = statFile(resolved);
    if (!st) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': ext === '.3mf' ? 'model/3mf' : 'model/stl',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    if (method === 'HEAD') return res.end();
    return fs.createReadStream(resolved).pipe(res);
  }

  // ── static ──────────────────────────────────────────────────────────────
  const entry = STATIC.get(p);
  if (entry && (method === 'GET' || method === 'HEAD')) return serveStatic(res, entry);

  return sendJson(res, 404, { error: 'not-found', path: p });
}

// ── server ────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'bad-url' });
  }
  // No CORS headers on purpose. This is same-origin only; behind Cloudflare
  // Access an allow-any-origin header would let any page the user visits ride
  // their Access cookie straight into this API.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  Promise.resolve(route(req, res, url)).catch((err) => {
    console.error('[web]', req.method, url.pathname, err);
    if (!res.headersSent) sendJson(res, err && err.status ? err.status : 500, { error: String((err && err.message) || err) });
  });
});

function shutdown(signal) {
  console.log(`\n[web] ${signal} — shutting down`);
  for (const res of sseClients) {
    try {
      res.end();
    } catch {}
  }
  sseClients.clear();
  if (pipelineChild) {
    // Hard rule: leave nothing running. A claw-gen child outlives its parent
    // otherwise and keeps a 10-minute mesh going with nobody listening.
    try {
      pipelineChild.kill('SIGTERM');
    } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  if (!fs.existsSync(WORKSPACE)) {
    console.error(`[web] workspace does not exist: ${WORKSPACE}`);
    process.exit(1);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // Wait for the ESM parser before accepting a request, so /api/model/params
  // can never answer "no parameters" merely because it was asked too early.
  scadParamsReady
    .catch((err) => console.error('[web] scad-params failed to load — Customize will be empty:', err.message))
    .then(() => {
      server.listen(PORT, HOST, () => {
        console.log(`[web] ClawSCAD Studio ${PKG_VERSION} — http://${HOST}:${PORT}`);
        console.log(`[web] workspace: ${WORKSPACE}`);
        console.log(`[web] state dir: ${STATE_DIR}`);
        console.log(`[web] claw-gen:  ${resolvePipelineCli() || '(not found — Preview and Recreate will explain and offer Direct)'}`);
        console.log(`[web] claude:    ${resolveClaude() || '(not found — Make it will explain)'}`);
        console.log(`[web] openscad:  ${resolveOpenscad() || '(not found — Customize and Export will explain)'}`);
      });
    });
}

module.exports = {
  server,
  containedInWorkspace,
  ingestImageBytes,
  startPipelineAction,
  normalizeChain,
  pipelineStatus,
  WORKSPACE,
  STATE_DIR,
  PORT,
};
