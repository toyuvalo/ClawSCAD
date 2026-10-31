#!/usr/bin/env node
/**
 * Standalone harness for Find & Print slicing and printing:
 * printer.js, slicer.js, runner.js, fixture-runner.js, index.js.
 *
 * Runs offline with fixtures only. No test framework required.
 * Never touches a real printer and never starts a real slicing process.
 *
 * Run: node tests/finder-print.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createPrinter, parseStatus } = require('../main/finder/printer.js');
const { createSlicer, fitProblem, filamentPresetFor } = require('../main/finder/slicer.js');
const { createFixtureRunner } = require('../main/finder/fixture-runner.js');
const { createFinder } = require('../main/finder/index.js');
const { createFixtureFetch, makeCubeStl } = require('../main/finder/fixture-fetch.js');
const { parseStl, bounds, writeBinaryStl } = require('../main/finder/mesh.js');
const { createZip } = require('../main/finder/zip.js');
const { FinderError } = require('../main/finder/errors.js');

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'finder');

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
    console.log(`  ${err.stack || err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // printer.js parseStatus
  // ───────────────────────────────────────────────────────────────────────────

  await check('printer: parseStatus parses bambu-status-idle.txt correctly', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'bambu-status-idle.txt'), 'utf-8');
    const s = parseStatus(text);

    assert.strictEqual(s.state, 'IDLE');
    assert.strictEqual(s.percent, 0);
    assert.strictEqual(s.layer, 0);
    assert.strictEqual(s.totalLayers, 0);
    assert.strictEqual(s.remainingMin, 0);
    assert.strictEqual(s.file, null); // '-' becomes null
    assert.strictEqual(s.nozzle, 0.4);
    assert.deepStrictEqual(s.hms, []);

    assert.strictEqual(s.trays.length, 4);

    // Tray 0: PLA #161616FF remain=-1%
    assert.strictEqual(s.trays[0].mapping, 0);
    assert.strictEqual(s.trays[0].slot, 1);
    assert.strictEqual(s.trays[0].type, 'PLA');
    assert.strictEqual(s.trays[0].color, '#161616'); // Alpha dropped
    assert.strictEqual(s.trays[0].brand, null);
    assert.strictEqual(s.trays[0].remain, null);
    assert.strictEqual(s.trays[0].empty, false);

    // Tray 1: PETG #D6CCA3FF PETG Basic remain=18%
    assert.strictEqual(s.trays[1].mapping, 1);
    assert.strictEqual(s.trays[1].slot, 2);
    assert.strictEqual(s.trays[1].type, 'PETG');
    assert.strictEqual(s.trays[1].color, '#D6CCA3');
    assert.strictEqual(s.trays[1].brand, 'PETG Basic');
    assert.strictEqual(s.trays[1].remain, 18);
    assert.strictEqual(s.trays[1].empty, false);

    // Tray 2: empty
    assert.strictEqual(s.trays[2].mapping, 2);
    assert.strictEqual(s.trays[2].slot, 3);
    assert.strictEqual(s.trays[2].empty, true);
    assert.strictEqual(s.trays[2].type, null);
    assert.strictEqual(s.trays[2].color, null);

    // Tray 3: PLA #68724DFF PLA Matte remain=88%
    assert.strictEqual(s.trays[3].mapping, 3);
    assert.strictEqual(s.trays[3].slot, 4);
    assert.strictEqual(s.trays[3].type, 'PLA');
    assert.strictEqual(s.trays[3].color, '#68724D');
    assert.strictEqual(s.trays[3].brand, 'PLA Matte');
    assert.strictEqual(s.trays[3].remain, 88);
    assert.strictEqual(s.trays[3].empty, false);
  });

  await check('printer: parseStatus parses bambu-status-running.txt correctly', async () => {
    const text = fs.readFileSync(path.join(FIXTURES_DIR, 'bambu-status-running.txt'), 'utf-8');
    const s = parseStatus(text);

    assert.strictEqual(s.state, 'RUNNING');
    assert.strictEqual(s.percent, 7);
    assert.strictEqual(s.layer, 1);
    assert.strictEqual(s.totalLayers, 41);
    assert.strictEqual(s.remainingMin, 292);
    assert.strictEqual(s.file, 'demo-pegs-plate1.gcode.3mf');
    assert.strictEqual(s.nozzle, 0.4);
    assert.strictEqual(s.trays.length, 4);
  });

  await check('printer: parseStatus parses HMS errors and handles garbage text safely', async () => {
    // Non-empty HMS errors
    const withHms = parseStatus('HMS errors: [{"code":1, "msg":"err"}]');
    assert.strictEqual(withHms.hms.length, 1);
    assert.strictEqual(withHms.hms[0].code, 1);

    // Garbage text does not throw and gives state null
    const garbage = parseStatus('Unrelated random log output\nSome invalid text lines\n');
    assert.strictEqual(garbage.state, null);
    assert.strictEqual(garbage.percent, null);
    assert.strictEqual(garbage.file, null);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // slicer.js fitProblem and filamentPresetFor
  // ───────────────────────────────────────────────────────────────────────────

  await check('slicer: fitProblem table validation', async () => {
    // OK part
    assert.strictEqual(fitProblem([100, 100, 50]), null);

    // 300 mm wide (over bed width 256)
    const wideProblem = fitProblem([300, 100, 50]);
    assert.ok(typeof wideProblem === 'string');
    assert.ok(wideProblem.includes('does not fit'));

    // 260 mm tall (over max height 250)
    const tallProblem = fitProblem([100, 100, 260]);
    assert.ok(typeof tallProblem === 'string');
    assert.ok(tallProblem.includes('prints up to 250 mm'));

    // 0.5 mm part (under 1 mm in every direction)
    const smallProblem = fitProblem([0.5, 0.5, 0.5]);
    assert.ok(typeof smallProblem === 'string');
    assert.ok(smallProblem.includes('under 1 mm'));

    // Front-left exclusion corner: hits when wide AND deep (225 x 205)
    // 128 - 225/2 = 15.5 < 18, and 128 - 205/2 = 25.5 < 28
    const excludeProblem = fitProblem([225, 205, 50]);
    assert.ok(typeof excludeProblem === 'string');
    assert.ok(excludeProblem.includes('front-left corner'));

    // Wide but not deep enough to hit exclusion corner (225 x 150)
    // 128 - 150/2 = 53 >= 28 -> fits!
    assert.strictEqual(fitProblem([225, 150, 50]), null);
  });

  await check('slicer: filamentPresetFor returns matching preset or null', async () => {
    assert.deepStrictEqual(filamentPresetFor('PLA'), { type: 'PLA', file: 'filament-pla-x1c.json' });
    assert.deepStrictEqual(filamentPresetFor('pla'), { type: 'PLA', file: 'filament-pla-x1c.json' });
    assert.deepStrictEqual(filamentPresetFor('PETG'), { type: 'PETG', file: 'filament-petg-basic-x1c.json' });
    assert.deepStrictEqual(filamentPresetFor('PETG-CF'), { type: 'PETG-CF', file: 'filament-petg-cf-x1c.json' });
    assert.strictEqual(filamentPresetFor('ABS'), null);
    assert.strictEqual(filamentPresetFor(null), null);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // slicer.runBambu hang guard
  // ───────────────────────────────────────────────────────────────────────────

  await check('slicer: runBambu hang guard - CLI writes complete zip then never exits (killed after settleMs)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-hang-'));
    try {
      const outPath = path.join(tmp, 'output.3mf');
      const validZip = createZip([{ name: 'model.txt', data: 'valid zip content' }]);
      let killed = false;
      let killCount = 0;
      let curTime = 1000;

      const fakeRunner = {
        start() {
          fs.writeFileSync(outPath, validZip);
          return {
            pid: 991,
            exited: new Promise(() => {}), // never exits
            exitCode: () => null,
            kill() {
              killed = true;
              killCount++;
            },
          };
        },
      };

      const slicer = createSlicer({
        runner: fakeRunner,
        config: { settleMs: 50, pollMs: 10, limitMs: 500, tries: 2, bambuStudio: 'studio.exe' },
        now: () => curTime,
        sleep: async (ms) => {
          curTime += ms;
          await new Promise((r) => setImmediate(r));
        },
      });

      const res = await slicer.runBambu(['arg'], outPath);
      assert.strictEqual(res, outPath);
      assert.strictEqual(killed, true);
      assert.strictEqual(killCount, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await check('slicer: runBambu hang guard - file that keeps changing is not killed early', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-hang-'));
    try {
      const outPath = path.join(tmp, 'output.3mf');
      let kills = 0;
      let curTime = 1000;
      let growTicks = 0;

      const fakeRunner = {
        start() {
          return {
            pid: 992,
            exited: new Promise(() => {}),
            exitCode: () => null,
            kill() {
              kills++;
            },
          };
        },
      };

      const slicer = createSlicer({
        runner: fakeRunner,
        config: { settleMs: 30, pollMs: 10, limitMs: 500, tries: 2, bambuStudio: 'studio.exe' },
        now: () => curTime,
        sleep: async (ms) => {
          curTime += ms;
          growTicks++;
          if (growTicks <= 5) {
            // While growing, elapsed time reaches 50ms (> settleMs 30ms), but it must NOT be killed early
            fs.writeFileSync(outPath, createZip([{ name: 'f.txt', data: 'data'.repeat(growTicks * 5) }]));
            assert.strictEqual(kills, 0, 'file was killed early while still growing');
          }
          await new Promise((r) => setImmediate(r));
        },
      });

      const res = await slicer.runBambu(['arg'], outPath);
      assert.strictEqual(res, outPath);
      assert.strictEqual(kills, 1);
      assert.ok(growTicks > 5);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await check('slicer: runBambu hang guard - CLI exits 0 without complete file throws slicer after tries', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-hang-'));
    try {
      const outPath = path.join(tmp, 'output.3mf');
      let starts = 0;

      const fakeRunner = {
        start() {
          starts++;
          return {
            pid: 993,
            exited: Promise.resolve(0),
            exitCode: () => 0,
            kill() {},
          };
        },
      };

      const slicer = createSlicer({
        runner: fakeRunner,
        config: { settleMs: 10, pollMs: 5, limitMs: 500, tries: 2, bambuStudio: 'studio.exe' },
      });

      await assert.rejects(
        () => slicer.runBambu(['arg'], outPath),
        (err) => err instanceof FinderError && err.code === 'slicer'
      );
      assert.strictEqual(starts, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await check('slicer: runBambu hang guard - first run exits without file, second run produces it', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-hang-'));
    try {
      const outPath = path.join(tmp, 'output.3mf');
      let starts = 0;
      const validZip = createZip([{ name: 'data.txt', data: 'round 2 zip' }]);

      const fakeRunner = {
        start() {
          starts++;
          if (starts === 2) {
            fs.writeFileSync(outPath, validZip);
          }
          return {
            pid: 994,
            exited: Promise.resolve(0),
            exitCode: () => 0,
            kill() {},
          };
        },
      };

      const slicer = createSlicer({
        runner: fakeRunner,
        config: { settleMs: 10, pollMs: 5, limitMs: 500, tries: 2, bambuStudio: 'studio.exe' },
      });

      const res = await slicer.runBambu(['arg'], outPath);
      assert.strictEqual(res, outPath);
      assert.strictEqual(starts, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await check('slicer: runBambu hang guard - stale output file is deleted before run starts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-hang-'));
    try {
      const outPath = path.join(tmp, 'output.3mf');
      fs.writeFileSync(outPath, 'stale file from previous run');
      let staleFileExistedAtStart = true;
      const validZip = createZip([{ name: 'data.txt', data: 'new zip' }]);

      const fakeRunner = {
        start() {
          staleFileExistedAtStart = fs.existsSync(outPath);
          fs.writeFileSync(outPath, validZip);
          return {
            pid: 995,
            exited: Promise.resolve(0),
            exitCode: () => 0,
            kill() {},
          };
        },
      };

      const slicer = createSlicer({
        runner: fakeRunner,
        config: { settleMs: 10, pollMs: 5, limitMs: 500, tries: 1, bambuStudio: 'studio.exe' },
      });

      await slicer.runBambu(['arg'], outPath);
      assert.strictEqual(staleFileExistedAtStart, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await check('slicer: runBambu hang guard - truncated zip is not accepted as complete', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-hang-'));
    try {
      const outPath = path.join(tmp, 'output.3mf');
      const validZip = createZip([{ name: 'data.txt', data: 'complete zip' }]);
      const truncated = validZip.subarray(0, Math.floor(validZip.length / 2));
      let starts = 0;

      const fakeRunner = {
        start() {
          starts++;
          fs.writeFileSync(outPath, truncated);
          return {
            pid: 996,
            exited: Promise.resolve(0),
            exitCode: () => 0,
            kill() {},
          };
        },
      };

      const slicer = createSlicer({
        runner: fakeRunner,
        config: { settleMs: 10, pollMs: 5, limitMs: 500, tries: 2, bambuStudio: 'studio.exe' },
      });

      await assert.rejects(
        () => slicer.runBambu(['arg'], outPath),
        (err) => err instanceof FinderError && err.code === 'slicer'
      );
      assert.strictEqual(starts, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await check('slicer: runBambu hang guard - limitMs exceeded calls kill and throws slicer', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-hang-'));
    try {
      const outPath = path.join(tmp, 'output.3mf');
      let killed = false;
      let curTime = 1000;

      const fakeRunner = {
        start() {
          return {
            pid: 997,
            exited: new Promise(() => {}),
            exitCode: () => null,
            kill() {
              killed = true;
            },
          };
        },
      };

      const slicer = createSlicer({
        runner: fakeRunner,
        config: { settleMs: 50, pollMs: 10, limitMs: 100, tries: 1, bambuStudio: 'studio.exe' },
        now: () => curTime,
        sleep: async (ms) => {
          curTime += ms;
          await new Promise((r) => setImmediate(r));
        },
      });

      await assert.rejects(
        () => slicer.runBambu(['arg'], outPath),
        (err) => err instanceof FinderError && err.code === 'slicer' && err.message.includes('without finishing')
      );
      assert.strictEqual(killed, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // slicer.slice with fixture runner
  // ───────────────────────────────────────────────────────────────────────────

  await check('slicer: slice with fixture runner produces gcode.3mf, estimate, and staged stl centred on bed', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-slice-'));
    try {
      const finder = createFinder({ cacheDir: path.join(ws, '.cache'), fetchImpl: createFixtureFetch(FIXTURES_DIR), minIntervalMs: 0 });
      const dl = await finder.download({ workspaceDir: ws, site: 'printables', id: '543553', fileId: '9990001' });

      const fixtureRunner = createFixtureRunner(FIXTURES_DIR);
      const slicer = createSlicer({
        runner: fixtureRunner,
        config: {
          bambuStudio: path.join(FIXTURES_DIR, 'bambu-studio.fixture'),
          presetDir: path.join(FIXTURES_DIR, 'presets'),
          assertStaged: path.join(FIXTURES_DIR, 'assert_staged.py'),
          settleMs: 0,
          pollMs: 5,
        },
      });

      const detail = { site: 'printables', siteId: '543553', title: 'Gridfinity Storage Box' };
      const res = await slicer.slice({
        workspaceDir: ws,
        detail,
        relPath: dl.path,
        trayType: 'PLA',
      });

      assert.strictEqual(res.ok, true);
      assert.ok(res.gcode3mf.startsWith('renders/finder/'));
      assert.ok(res.gcode3mf.endsWith('.gcode.3mf'));
      assert.deepStrictEqual(res.estimate, { time: '13m 40s', grams: 7.25, layers: 100 });

      // Staged STL check
      const outDir = path.dirname(path.join(ws, res.gcode3mf));
      const stagedStlPath = path.join(outDir, `${res.name}.stl`);
      assert.ok(fs.existsSync(stagedStlPath));
      const stagedMesh = parseStl(fs.readFileSync(stagedStlPath));
      const stagedBBox = bounds(stagedMesh);
      assert.strictEqual((stagedBBox.min[0] + stagedBBox.max[0]) / 2, 128);
      assert.strictEqual((stagedBBox.min[1] + stagedBBox.max[1]) / 2, 128);
      assert.strictEqual(stagedBBox.min[2], 0);

      // Verify runner calls
      const studioCalls = fixtureRunner.calls.filter((c) => c.file === 'bambu-studio.fixture');
      assert.strictEqual(studioCalls.length, 2);

      // First call: assemble
      const c1 = studioCalls[0].args;
      assert.ok(c1.includes('--load-assemble-list'));
      const arrangeIdx1 = c1.indexOf('--arrange');
      assert.ok(arrangeIdx1 >= 0 && c1[arrangeIdx1 + 1] === '0');
      const settingsIdx = c1.indexOf('--load-settings');
      assert.ok(settingsIdx >= 0 && c1[settingsIdx + 1].includes(';') && c1[settingsIdx + 1].includes('machine-p1s.json'));

      // Second call: slice
      const c2 = studioCalls[1].args;
      const sliceIdx = c2.indexOf('--slice');
      assert.ok(sliceIdx >= 0 && c2[sliceIdx + 1] === '0');
      const arrangeIdx2 = c2.indexOf('--arrange');
      assert.ok(arrangeIdx2 >= 0 && c2[arrangeIdx2 + 1] === '0');

      // Error case: unsupported filament
      await assert.rejects(
        () => slicer.slice({ workspaceDir: ws, detail, relPath: dl.path, trayType: 'ABS' }),
        (err) => err instanceof FinderError && err.code === 'unsupported-filament'
      );

      // Error case: part too big
      const bigStlDir = path.join(ws, 'models', 'printables-543553');
      const bigCube = makeCubeStl(300);
      fs.writeFileSync(path.join(bigStlDir, 'big-cube.stl'), bigCube);
      const runnerCallCount = fixtureRunner.calls.length;
      await assert.rejects(
        () => slicer.slice({ workspaceDir: ws, detail, relPath: 'models/printables-543553/big-cube.stl', trayType: 'PLA' }),
        (err) => err instanceof FinderError && err.code === 'too-big'
      );
      assert.strictEqual(fixtureRunner.calls.length, runnerCallCount); // Runner never started

      // Error case: missing preset dir
      const brokenSlicer = createSlicer({
        runner: fixtureRunner,
        config: {
          bambuStudio: path.join(FIXTURES_DIR, 'bambu-studio.fixture'),
          presetDir: path.join(ws, 'nonexistent-presets'),
        },
      });
      await assert.rejects(
        () => brokenSlicer.slice({ workspaceDir: ws, detail, relPath: dl.path, trayType: 'PLA' }),
        (err) => err instanceof FinderError && err.code === 'slicer-missing'
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // printer.start guards and refuse cases
  // ───────────────────────────────────────────────────────────────────────────

  await check('printer: start guards refuse invalid invocations without calling print', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-pr-'));
    try {
      const runner = createFixtureRunner(FIXTURES_DIR);
      let curTime = 1000;
      const printer = createPrinter({
        runner,
        config: { bambuCtl: path.join(FIXTURES_DIR, 'bambu_ctl.py') },
        now: () => curTime,
      });

      const rendersDir = path.join(ws, 'renders', 'finder');
      const jobDir = path.join(rendersDir, 'test-job-123456');
      fs.mkdirSync(jobDir, { recursive: true });

      // Build a valid fixture gcode.3mf
      const gcode3mf = path.join(jobDir, 'test.gcode.3mf');
      fs.writeFileSync(
        gcode3mf,
        createZip([
          { name: '[Content_Types].xml', data: '<Types/>' },
          { name: 'Metadata/plate_1.gcode', data: '; HEADER_BLOCK_START\n; total estimated time: 10m\n; HEADER_BLOCK_END\n' },
        ])
      );

      // Snapshot taken through printer.snapshot
      const snap = await printer.snapshot({ outDir: path.join(rendersDir, 'snapshots') });
      assert.ok(snap.token);

      const validArgs = {
        gcode3mf,
        rendersDir,
        mapping: 0,
        name: 'test-print',
        bedClear: true,
        snapshotToken: snap.token,
      };

      // 1. bedClear false
      await assert.rejects(
        () => printer.start({ ...validArgs, bedClear: false }),
        (err) => err instanceof FinderError && err.code === 'not-confirmed'
      );

      // 2. bedClear 'true' string
      await assert.rejects(
        () => printer.start({ ...validArgs, bedClear: 'true' }),
        (err) => err instanceof FinderError && err.code === 'not-confirmed'
      );

      // 3. bedClear undefined
      await assert.rejects(
        () => printer.start({ ...validArgs, bedClear: undefined }),
        (err) => err instanceof FinderError && err.code === 'not-confirmed'
      );

      // 4. No snapshot token
      await assert.rejects(
        () => printer.start({ ...validArgs, snapshotToken: undefined }),
        (err) => err instanceof FinderError && err.code === 'not-confirmed'
      );

      // 5. Unknown snapshot token
      await assert.rejects(
        () => printer.start({ ...validArgs, snapshotToken: 'unknown-token-123' }),
        (err) => err instanceof FinderError && err.code === 'not-confirmed'
      );

      // 6. Token older than 15 minutes
      curTime += 16 * 60 * 1000;
      await assert.rejects(
        () => printer.start(validArgs),
        (err) => err instanceof FinderError && err.code === 'not-confirmed'
      );
      curTime = 1000; // Reset time

      // Take fresh snapshot for remaining tests
      const freshSnap = await printer.snapshot({ outDir: path.join(rendersDir, 'snapshots') });
      validArgs.snapshotToken = freshSnap.token;

      // 7. Printer state RUNNING
      const busyRunner = createFixtureRunner(FIXTURES_DIR, { env: { CLAWSCAD_FINDER_PRINTER_STATE: 'RUNNING' } });
      const busyPrinter = createPrinter({ runner: busyRunner, config: { bambuCtl: path.join(FIXTURES_DIR, 'bambu_ctl.py') } });
      const busySnap = await busyPrinter.snapshot({ outDir: path.join(rendersDir, 'snapshots') });
      await assert.rejects(
        () => busyPrinter.start({ ...validArgs, snapshotToken: busySnap.token }),
        (err) => err instanceof FinderError && err.code === 'printer-busy'
      );

      // 8. Mapping pointing at empty tray (mapping 2 in idle fixture)
      await assert.rejects(
        () => printer.start({ ...validArgs, mapping: 2 }),
        (err) => err instanceof FinderError && err.code === 'bad-request'
      );

      // 9. gcode3mf outside renders/finder
      const outsideFile = path.join(ws, 'outside.gcode.3mf');
      fs.writeFileSync(outsideFile, fs.readFileSync(gcode3mf));
      await assert.rejects(
        () => printer.start({ ...validArgs, gcode3mf: outsideFile }),
        (err) => err instanceof FinderError && err.code === 'path'
      );

      // 10. File not ending .gcode.3mf
      const notGcode3mf = path.join(jobDir, 'test.stl');
      fs.writeFileSync(notGcode3mf, fs.readFileSync(gcode3mf));
      await assert.rejects(
        () => printer.start({ ...validArgs, gcode3mf: notGcode3mf }),
        (err) => err instanceof FinderError && err.code === 'path'
      );

      // 11. Corrupted zip
      const corruptFile = path.join(jobDir, 'corrupt.gcode.3mf');
      fs.writeFileSync(corruptFile, Buffer.from('not a zip file at all'));
      await assert.rejects(
        () => printer.start({ ...validArgs, gcode3mf: corruptFile }),
        (err) => err instanceof FinderError && err.code === 'slicer'
      );

      // Assert that runner call log has NO 'print' call across all refuse cases
      const printCalls = runner.calls.filter((c) => c.args.includes('print'));
      assert.strictEqual(printCalls.length, 0);

      // Happy path: start succeeds
      const startRes = await printer.start(validArgs);
      assert.strictEqual(startRes.started, true);

      // Check exact arguments passed to runner
      const happyPrintCalls = runner.calls.filter((c) => c.args.includes('print'));
      assert.strictEqual(happyPrintCalls.length, 1);
      assert.deepStrictEqual(happyPrintCalls[0].args, [
        path.join(FIXTURES_DIR, 'bambu_ctl.py'),
        'print',
        gcode3mf,
        '--ams-mapping',
        '0',
        '--name',
        'test-print',
        '--timeout',
        '420',
      ]);

      // Token reused after successful start (single use) is refused
      await assert.rejects(
        () => printer.start(validArgs),
        (err) => err instanceof FinderError && err.code === 'not-confirmed'
      );

      // Status caching & fresh bypass
      const statusCallsBefore = runner.calls.filter((c) => c.args.includes('status')).length;
      const s1 = await printer.status();
      assert.strictEqual(s1.cached, false);
      const s2 = await printer.status();
      assert.strictEqual(s2.cached, true);
      const statusCallsAfterCached = runner.calls.filter((c) => c.args.includes('status')).length;
      assert.strictEqual(statusCallsAfterCached, statusCallsBefore + 1);

      const s3 = await printer.status({ fresh: true });
      assert.strictEqual(s3.cached, false);
      const statusCallsAfterFresh = runner.calls.filter((c) => c.args.includes('status')).length;
      assert.strictEqual(statusCallsAfterFresh, statusCallsBefore + 2);

      // Serialisation: two overlapping status calls never run at the same time
      const [p1, p2] = await Promise.all([printer.status({ fresh: true }), printer.status({ fresh: true })]);
      assert.strictEqual(p1.ok, true);
      assert.strictEqual(p2.ok, true);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // index.js full print workflow
  // ───────────────────────────────────────────────────────────────────────────

  await check('index: full print workflow and desktop-only guard', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-idx-'));
    try {
      const runner = createFixtureRunner(FIXTURES_DIR);
      const finder = createFinder({
        cacheDir: path.join(ws, '.cache'),
        fetchImpl: createFixtureFetch(FIXTURES_DIR),
        runner,
        printing: true,
        minIntervalMs: 0,
        config: {
          slicer: {
            bambuStudio: path.join(FIXTURES_DIR, 'bambu-studio.fixture'),
            presetDir: path.join(FIXTURES_DIR, 'presets'),
            assertStaged: path.join(FIXTURES_DIR, 'assert_staged.py'),
            settleMs: 0,
            pollMs: 5,
          },
          printer: {
            bambuCtl: path.join(FIXTURES_DIR, 'bambu_ctl.py'),
          },
        },
      });

      // Download cube
      const dl = await finder.download({ workspaceDir: ws, site: 'printables', id: '543553', fileId: '9990001' });

      // printPrepare for empty slot (mapping 2) reaches job error bad-request
      const badPrep = await finder.printPrepare({
        workspaceDir: ws,
        site: 'printables',
        id: '543553',
        path: dl.path,
        mapping: 2,
      });
      assert.strictEqual(badPrep.ok, true);
      let badJob;
      for (let i = 0; i < 40; i++) {
        badJob = finder.job(badPrep.jobId).job;
        if (badJob.status === 'done' || badJob.status === 'error') break;
        await sleep(10);
      }
      assert.strictEqual(badJob.status, 'error');
      assert.strictEqual(badJob.error.code, 'bad-request');

      // printPrepare for valid slot (mapping 0) reaches job done
      const prep = await finder.printPrepare({
        workspaceDir: ws,
        site: 'printables',
        id: '543553',
        path: dl.path,
        mapping: 0,
      });
      assert.strictEqual(prep.ok, true);
      let prepJob;
      for (let i = 0; i < 40; i++) {
        prepJob = finder.job(prep.jobId).job;
        if (prepJob.status === 'done' || prepJob.status === 'error') break;
        await sleep(10);
      }
      assert.strictEqual(prepJob.status, 'done');
      assert.ok(prepJob.result.gcode3mf);
      assert.strictEqual(prepJob.result.mapping, 0);
      assert.strictEqual(prepJob.result.slot, 1);
      assert.strictEqual(prepJob.result.trayColor, '#161616');

      // printStart without done prepare job returns not-found
      const noPrepRes = await finder.printStart({
        workspaceDir: ws,
        prepareJobId: 'nonexistent-job-id',
        bedClear: true,
        snapshotToken: 'token',
      });
      assert.strictEqual(noPrepRes.ok, false);
      assert.strictEqual(noPrepRes.error.code, 'not-found');

      // printStart with bedClear: false is refused immediately (no job created)
      const noConfirmRes = await finder.printStart({
        workspaceDir: ws,
        prepareJobId: prep.jobId,
        bedClear: false,
        snapshotToken: 'token',
      });
      assert.strictEqual(noConfirmRes.ok, false);
      assert.strictEqual(noConfirmRes.error.code, 'not-confirmed');
      assert.strictEqual(noConfirmRes.jobId, undefined);

      // Snapshot
      const snap = await finder.printerSnapshot({ workspaceDir: ws });
      assert.strictEqual(snap.ok, true);
      assert.ok(snap.token);

      // Full prepare -> snapshot -> printStart sequence yields one print call
      const startRes = await finder.printStart({
        workspaceDir: ws,
        prepareJobId: prep.jobId,
        bedClear: true,
        snapshotToken: snap.token,
      });
      assert.strictEqual(startRes.ok, true);
      let printJob;
      for (let i = 0; i < 40; i++) {
        printJob = finder.job(startRes.jobId).job;
        if (printJob.status === 'done' || printJob.status === 'error') break;
        await sleep(10);
      }
      assert.strictEqual(printJob.status, 'done');
      const printCalls = runner.calls.filter((c) => c.args.includes('print'));
      assert.strictEqual(printCalls.length, 1);

      // Second printStart with same snapshot token is refused
      const secondStart = await finder.printStart({
        workspaceDir: ws,
        prepareJobId: prep.jobId,
        bedClear: true,
        snapshotToken: snap.token,
      });
      assert.strictEqual(secondStart.ok, false);
      assert.strictEqual(secondStart.error.code, 'not-confirmed');

      // job(unknown) -> not-found
      const unknownJob = finder.job('unknown-job-id-999');
      assert.strictEqual(unknownJob.ok, false);
      assert.strictEqual(unknownJob.error.code, 'not-found');

      // With printing: false every print* method answers desktop-only and runner log is empty
      const webRunner = createFixtureRunner(FIXTURES_DIR);
      const webFinder = createFinder({
        cacheDir: path.join(ws, '.cache'),
        fetchImpl: createFixtureFetch(FIXTURES_DIR),
        runner: webRunner,
        printing: false,
        minIntervalMs: 0,
      });

      const s = await webFinder.printerStatus();
      assert.strictEqual(s.ok, false);
      assert.strictEqual(s.error.code, 'desktop-only');

      const sn = await webFinder.printerSnapshot({ workspaceDir: ws });
      assert.strictEqual(sn.ok, false);
      assert.strictEqual(sn.error.code, 'desktop-only');

      const pp = await webFinder.printPrepare({ workspaceDir: ws, site: 'printables', id: '543553', path: dl.path, mapping: 0 });
      assert.strictEqual(pp.ok, false);
      assert.strictEqual(pp.error.code, 'desktop-only');

      const ps = await webFinder.printStart({ workspaceDir: ws, prepareJobId: prep.jobId, bedClear: true, snapshotToken: 'token' });
      assert.strictEqual(ps.ok, false);
      assert.strictEqual(ps.error.code, 'desktop-only');

      assert.strictEqual(webRunner.calls.length, 0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  console.log(`\nfinder-print: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
