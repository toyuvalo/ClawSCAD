#!/usr/bin/env node
/**
 * Find & Print: the seams between the pieces.
 *
 * The unit tests (finder-core, finder-files, finder-print, web-finder) check each
 * module on its own. This file checks the places where one piece is wired to
 * another, because that is where a feature silently half-works:
 *
 *  - preload.js exposes a finder* method for every IPC channel main registers, and
 *    for no channel it does not. preload.js says why in a comment: an exposed
 *    method with no handler rejects at CALL time, in production, not at launch.
 *  - the browser shim (web/api-shim.js) offers the same finder* methods as the
 *    desktop bridge, so renderer/finder.js cannot tell the two apart.
 *  - the workspace-bound handlers refuse when no workspace is open, and the open
 *    handler really hands the new .scad to the checkpoint registry.
 *  - only the model's own https pages may be opened in the user's browser.
 *  - ZIP64 archives are read (a real Fusion 360 3MF from Printables is one — the
 *    first live run of "Open in ClawSCAD" failed on it with "zip64 not supported").
 *  - a tool path set in the environment moves the slicer / printer, and an explicit
 *    config still wins over it.
 *
 * Run: node tests/finder-wiring.js
 */

'use strict';

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'finder');

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

/** Rewrites a normal zip as ZIP64: sizes and offsets move to the 0x0001 extra field. */
function toZip64(buf) {
  const { listZip } = require(path.join(APP, 'main', 'finder', 'zip.js'));
  const entries = listZip(buf);
  const eocd = buf.length - 22;
  const cdStart = buf.readUInt32LE(eocd + 16);
  const parts = [buf.subarray(0, cdStart)];
  const cds = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf-8');
    const extra = Buffer.alloc(4 + 24);
    extra.writeUInt16LE(1, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(e.size), 4);
    extra.writeBigUInt64LE(BigInt(e.compSize), 12);
    extra.writeBigUInt64LE(BigInt(e.localOffset), 20);
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(45, 4);
    h.writeUInt16LE(45, 6);
    h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(e.method, 10);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(0xffffffff, 20);
    h.writeUInt32LE(0xffffffff, 24);
    h.writeUInt16LE(name.length, 28);
    h.writeUInt16LE(extra.length, 30);
    h.writeUInt32LE(0xffffffff, 42);
    cds.push(h, name, extra);
  }
  const cd = Buffer.concat(cds);
  const z64At = cdStart + cd.length;
  const z64 = Buffer.alloc(56);
  z64.writeUInt32LE(0x06064b50, 0);
  z64.writeBigUInt64LE(44n, 4);
  z64.writeUInt16LE(45, 12);
  z64.writeUInt16LE(45, 14);
  z64.writeBigUInt64LE(BigInt(entries.length), 24);
  z64.writeBigUInt64LE(BigInt(entries.length), 32);
  z64.writeBigUInt64LE(BigInt(cd.length), 40);
  z64.writeBigUInt64LE(BigInt(cdStart), 48);
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  loc.writeBigUInt64LE(BigInt(z64At), 8);
  loc.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  parts.push(cd, z64, loc, end);
  return Buffer.concat(parts);
}

(async () => {
  // ── ZIP64 ──────────────────────────────────────────────────────────────
  const { createZip, listZip, readByName, isCompleteZip } = require(path.join(APP, 'main', 'finder', 'zip.js'));
  const { parse3mf, bounds } = require(path.join(APP, 'main', 'finder', 'mesh.js'));
  const { kebab } = require(path.join(APP, 'main', 'finder', 'paths.js'));

  await check('zip64: a ZIP64 archive lists, reads and verifies like a normal one', () => {
    const plain = createZip([
      { name: 'a.txt', data: 'hello zip64' },
      { name: 'dir/b.bin', data: Buffer.alloc(5000, 7) },
    ]);
    const z = toZip64(plain);
    assert.ok(listZip(z).length === 2);
    assert.strictEqual(readByName(z, 'a.txt').toString(), 'hello zip64');
    assert.strictEqual(readByName(z, 'dir/b.bin').length, 5000);
    assert.strictEqual(isCompleteZip(z), true);
  });

  await check('zip64: a ZIP64 archive with a flipped data byte is NOT complete', () => {
    const z = toZip64(createZip([{ name: 'a.txt', data: 'x'.repeat(200) }], { deflate: false }));
    const bad = Buffer.from(z);
    bad[40] ^= 0xff; // inside the stored bytes of the first entry
    assert.strictEqual(isCompleteZip(bad), false);
  });

  await check('zip64: a ZIP64 3MF opens as a mesh', () => {
    const model =
      '<?xml version="1.0"?><model unit="millimeter"><resources><object id="1" type="model"><mesh><vertices>' +
      '<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices>' +
      '<triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/></triangles>' +
      '</mesh></object></resources><build><item objectid="1"/></build></model>';
    const z = toZip64(createZip([{ name: '3D/3dmodel.model', data: model }]));
    const mesh = parse3mf(z);
    assert.strictEqual(mesh.triangles, 4);
    assert.deepStrictEqual(bounds(mesh).dims, [10, 10, 10]);
  });

  await check('zip64: a zip64 flag with no zip64 record is refused, not misread', () => {
    const plain = createZip([{ name: 'a.txt', data: 'x' }]);
    const bad = Buffer.from(plain);
    bad.writeUInt32LE(0xffffffff, bad.length - 22 + 16); // central-directory offset says "see zip64"
    assert.throws(() => listZip(bad), /zip64/);
  });

  // ── names ──────────────────────────────────────────────────────────────
  await check('kebab: cuts at a word edge, not in the middle of a word', () => {
    assert.strictEqual(kebab('Gridfinity Storage Box by Pred (now parametric)', 25), 'gridfinity-storage-box-by');
    assert.strictEqual(kebab('abcdefghijklmnopqrstuvwxyz', 10), 'abcdefghij'); // no edge to cut at
    assert.strictEqual(kebab('short', 25), 'short');
    assert.strictEqual(kebab('', 10), 'model');
    assert.ok(kebab('x'.repeat(100), 30).length <= 30);
  });

  // ── external links ─────────────────────────────────────────────────────
  const mf = require(path.join(APP, 'main', 'model-finder.js'));
  await check('external links: only https pages on the sites we search may be opened', () => {
    const ok = mf._internal.isAllowedExternal;
    for (const u of ['https://www.printables.com/model/1-x', 'https://makerworld.com/en/models/2-y', 'https://www.thingiverse.com/thing:1', 'https://creativecommons.org/licenses/by/4.0/']) assert.strictEqual(ok(u), true, u);
    for (const u of [
      'http://www.printables.com/model/1',
      'https://printables.com.evil.test/model/1',
      'https://evilprintables.com/x',
      'https://makerworld.com@evil.test/',
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'ms-msdt:/id',
      '',
      'not a url',
    ]) assert.strictEqual(ok(u), false, u);
  });

  // ── IPC wiring ─────────────────────────────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finder-wiring-'));
  const savedEnv = { f: process.env.CLAWSCAD_FINDER_FIXTURES, i: process.env.CLAWSCAD_FINDER_MIN_INTERVAL_MS };
  process.env.CLAWSCAD_FINDER_FIXTURES = FIXTURES;
  process.env.CLAWSCAD_FINDER_MIN_INTERVAL_MS = '0';
  try {
    const handlers = new Map();
    const checkpoints = [];
    mf.register(
      { handle: (ch, fn) => handlers.set(ch, fn) },
      { getCtx: (event) => (event && event.ctx) || null, addCheckpoint: (ctx, scad) => (checkpoints.push({ ctx, scad }), 'cp-1'), app: { getPath: () => path.join(tmp, 'userData') } }
    );

    await check('wiring: preload.js exposes exactly the finder channels main registers', () => {
      const preload = fs.readFileSync(path.join(APP, 'preload.js'), 'utf-8');
      const exposed = new Set([...preload.matchAll(/ipcRenderer\.invoke\('(finder:[a-z-]+)'/g)].map((m) => m[1]));
      const registered = new Set([...handlers.keys()]);
      assert.ok(registered.size >= 11, `only ${registered.size} channels registered`);
      assert.deepStrictEqual([...exposed].sort(), [...registered].sort());
    });

    await check('wiring: the browser shim offers the same finder methods as the desktop bridge', () => {
      const names = (file) => new Set([...fs.readFileSync(path.join(APP, file), 'utf-8').matchAll(/^\s+(finder[A-Za-z]+):/gm)].map((m) => m[1]));
      const desktop = names('preload.js');
      const web = names(path.join('web', 'api-shim.js'));
      desktop.delete('finderOpenExternal'); // a browser opens a plain <a target=_blank>; documented in the shim
      assert.ok(desktop.size >= 10);
      assert.deepStrictEqual([...web].sort(), [...desktop].sort());
    });

    await check('wiring: every method renderer/finder.js calls exists in the desktop bridge', () => {
      const used = new Set([...fs.readFileSync(path.join(APP, 'renderer', 'finder.js'), 'utf-8').matchAll(/api\.(finder[A-Za-z]+)/g)].map((m) => m[1]));
      const preload = fs.readFileSync(path.join(APP, 'preload.js'), 'utf-8');
      for (const name of used) assert.ok(new RegExp(`\\b${name}:`).test(preload), `${name} is called by the renderer but not exposed by preload.js`);
    });

    await check('wiring: handlers that need a workspace refuse cleanly when none is open', async () => {
      for (const ch of ['finder:download', 'finder:open', 'finder:printer-snapshot', 'finder:print-prepare', 'finder:print-start']) {
        const out = await handlers.get(ch)({ ctx: null }, {});
        assert.strictEqual(out.ok, false, ch);
        assert.strictEqual(out.error.code, 'no-workspace', ch);
      }
    });

    await check('wiring: a non-object payload is treated as empty, never thrown on', async () => {
      for (const bad of [null, 'x', 42, [1, 2]]) {
        const out = await handlers.get('finder:search')({}, bad);
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.error.code, 'bad-request');
      }
    });

    await check('wiring: download then open registers the new checkpoint with the window registry', async () => {
      const ws = path.join(tmp, 'ws');
      fs.mkdirSync(ws, { recursive: true });
      const event = { ctx: { workspaceDir: ws } };
      const dl = await handlers.get('finder:download')(event, { site: 'printables', id: '543553', fileId: '9990001' });
      assert.strictEqual(dl.ok, true, JSON.stringify(dl));
      const op = await handlers.get('finder:open')(event, { site: 'printables', id: '543553', path: dl.path });
      assert.strictEqual(op.ok, true, JSON.stringify(op));
      assert.strictEqual(checkpoints.length, 1);
      assert.strictEqual(checkpoints[0].ctx, event.ctx);
      assert.strictEqual(checkpoints[0].scad, path.join(ws, op.scad));
      assert.strictEqual(op.checkpointId, 'cp-1');
    });

    await check('wiring: opening an evil link returns false and never reaches the shell', async () => {
      assert.strictEqual(await handlers.get('finder:open-external')({}, 'file:///C:/Windows/notepad.exe'), false);
      assert.strictEqual(await handlers.get('finder:open-external')({}, 42), false);
    });
  } finally {
    for (const [k, v] of [['CLAWSCAD_FINDER_FIXTURES', savedEnv.f], ['CLAWSCAD_FINDER_MIN_INTERVAL_MS', savedEnv.i]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // ── tool paths ─────────────────────────────────────────────────────────
  const { createFinder } = require(path.join(APP, 'main', 'finder', 'index.js'));
  await check('tool paths: environment variables move the slicer and the printer, explicit config wins', () => {
    const env = { CLAWSCAD_BAMBU_STUDIO: 'S:/bs.exe', CLAWSCAD_P1S_PRESETS: 'S:/presets', CLAWSCAD_BAMBU_CTL: 'S:/ctl.py', CLAWSCAD_PYTHON: 'S:/py.exe' };
    const a = createFinder({ printing: true, env, runner: { run() {}, start() {} } });
    assert.strictEqual(a._slicer.config.bambuStudio, 'S:/bs.exe');
    assert.strictEqual(a._slicer.config.presetDir, 'S:/presets');
    assert.strictEqual(a._printer.config.bambuCtl, 'S:/ctl.py');
    assert.strictEqual(a._printer.config.python, 'S:/py.exe');
    const b = createFinder({ printing: true, env, runner: { run() {}, start() {} }, config: { slicer: { bambuStudio: 'X:/other.exe' }, printer: { bambuCtl: 'X:/other.py' } } });
    assert.strictEqual(b._slicer.config.bambuStudio, 'X:/other.exe');
    assert.strictEqual(b._printer.config.bambuCtl, 'X:/other.py');
    assert.strictEqual(b._slicer.config.presetDir, 'S:/presets'); // env still applies where config is silent
  });

  await check('tool paths: with printing off there is no slicer and no printer object at all', () => {
    const f = createFinder({ printing: false, env: {} });
    assert.strictEqual(f._slicer, null);
    assert.strictEqual(f._printer, null);
  });

  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* left in %TEMP% */
  }
  console.log(`\nfinder-wiring: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('finder-wiring crashed:', err);
  process.exit(1);
});
