// main/finder/slicer.js — slice a downloaded mesh for the P1S with the Bambu
// Studio CLI. A JavaScript port of the proven Python path in
// E:\clawscad-workspace\tools\build_puzzle_3mf.py (run_bambu(), assemble(),
// slice_()), with the gotchas of wiki/systems/bambu-studio-cli-gotchas.md built in:
//
//   - #7  the CLI does not resolve preset `inherits`, so only the FLATTENED
//         presets in flat-presets-p1s are used (real 256x256 bed, no phantom 200).
//   - #6/#8 the part is centred on the bed centre (128,128) with its base on Z=0
//         BEFORE the CLI sees it, and `--arrange 0` is passed, so nothing is
//         rotated or moved off the plate.
//   - hang: the CLI can write a complete file and never exit. We delete the old
//         output first, accept the new one once it is a whole zip that has not
//         changed for `settleMs`, then kill THAT PID. A CLI that exits without a
//         complete file is run once more.
//
// The runner is injected: tests and fixture mode pass a fake and nothing real
// starts. Nothing in this file talks to the printer.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FinderError } = require('./errors.js');
const { loadMesh, centredOn, bounds, writeBinaryStl } = require('./mesh.js');
const { isCompleteZip, readByName, listZip } = require('./zip.js');
const { kebab, modelDir, resolveFileWithin, toRel, isReallyInside } = require('./paths.js');

const BED = 256;
const CENTRE = BED / 2;
const MAX_Z = 250;
const EXCLUDE = { x: 18, y: 28 }; // P1S bed_exclude_area, front-left corner
const FILAMENT_PRESETS = { PLA: 'filament-pla-x1c.json', PETG: 'filament-petg-basic-x1c.json', 'PETG-CF': 'filament-petg-cf-x1c.json' };

const DEFAULTS = {
  bambuStudio: 'C:/Program Files/Bambu Studio/bambu-studio.exe',
  presetDir: 'E:/the-workshop/_3mf/flat-presets-p1s',
  assertStaged: 'E:/the-workshop/_3mf/assert_staged.py',
  python: 'python',
  machine: 'machine-p1s.json',
  process: 'process-p1s-functional.json',
  settleMs: 60000,
  limitMs: 45 * 60 * 1000,
  pollMs: 5000,
  tries: 2,
};

/** @returns {string|null} a plain sentence when the part cannot fit the P1S bed */
function fitProblem(dims) {
  const [w, d, h] = dims;
  if (!(w > 0 && d > 0 && h > 0)) return 'This model has no size, so it cannot be sliced.';
  if (w < 1 && d < 1 && h < 1) return 'This model is under 1 mm in every direction. It is probably not in millimetres.';
  if (w > BED - 6 || d > BED - 6) {
    return `This model is ${w.toFixed(0)} x ${d.toFixed(0)} mm. The P1S bed is ${BED} x ${BED} mm, so it does not fit as it is.`;
  }
  if (h > MAX_Z) return `This model is ${h.toFixed(0)} mm tall. The P1S prints up to ${MAX_Z} mm.`;
  // Centred on the bed, the part reaches the front-left exclusion corner only if it is wide AND deep.
  if (CENTRE - w / 2 < EXCLUDE.x && CENTRE - d / 2 < EXCLUDE.y) {
    return 'Centred on the bed, this model would overlap the P1S front-left corner that cannot be printed on.';
  }
  return null;
}

function filamentPresetFor(trayType) {
  const key = String(trayType || '').toUpperCase().trim();
  return Object.prototype.hasOwnProperty.call(FILAMENT_PRESETS, key) ? { type: key, file: FILAMENT_PRESETS[key] } : null;
}

function createSlicer({ runner, config = {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const cfg = { ...DEFAULTS, ...config };

  /** Files the slicing path needs and does not find. Empty array = ready. */
  function missing() {
    const need = [
      ['Bambu Studio', cfg.bambuStudio],
      ['the P1S machine preset', path.join(cfg.presetDir, cfg.machine)],
      ['the P1S process preset', path.join(cfg.presetDir, cfg.process)],
      ['the PLA filament preset', path.join(cfg.presetDir, FILAMENT_PRESETS.PLA)],
    ];
    return need.filter(([, p]) => !fs.existsSync(p)).map(([what, p]) => `${what} (${p})`);
  }

  // (size, mtime) of `out` if it is a complete zip, else null. Re-validated only
  // when the file actually changed, so a 5 s poll does not re-inflate 20 MB.
  let lastKey = null;
  let lastValid = false;
  function completeStamp(out) {
    let st;
    try {
      st = fs.statSync(out);
    } catch {
      lastKey = null;
      return null;
    }
    const key = `${st.size}:${st.mtimeMs}`;
    if (key !== lastKey) {
      lastKey = key;
      try {
        lastValid = isCompleteZip(fs.readFileSync(out));
      } catch {
        lastValid = false;
      }
    }
    return lastValid ? key : null;
  }

  async function runOnce(args, out, logPath, cwd, onNote) {
    const handle = runner.start(cfg.bambuStudio, args, { cwd, logPath });
    const t0 = now();
    let seen = null;
    let seenAt = 0;
    for (;;) {
      const tick = await Promise.race([handle.exited.then((code) => ({ exited: true, code })), sleep(cfg.pollMs).then(() => ({ exited: false }))]);
      if (tick.exited) return tick.code;
      const t = now();
      const stamp = completeStamp(out);
      if (stamp && stamp === seen && t - seenAt >= cfg.settleMs) {
        onNote(`Bambu Studio wrote ${path.basename(out)} but did not exit; stopping PID ${handle.pid}.`);
        handle.kill();
        return handle.exitCode();
      }
      if (stamp !== seen) {
        seen = stamp;
        seenAt = t;
      }
      if (t - t0 > cfg.limitMs) {
        handle.kill();
        throw new FinderError('slicer', `Bambu Studio ran ${Math.round(cfg.limitMs / 60000)} minutes without finishing ${path.basename(out)}, so it was stopped.`);
      }
    }
  }

  /** run_bambu(): returns `out` once it is a complete zip; throws otherwise. */
  async function runBambu(args, out, { cwd, onNote = () => {} } = {}) {
    const logPath = out + '.cli.log';
    let code = null;
    for (let attempt = 1; attempt <= cfg.tries; attempt++) {
      fs.rmSync(out, { force: true });
      fs.rmSync(out + '.tmp', { force: true });
      lastKey = null;
      code = await runOnce(args, out, logPath, cwd, onNote);
      if (completeStamp(out)) return out;
      if (attempt < cfg.tries) onNote(`Bambu Studio exited with code ${code} without a complete ${path.basename(out)}; running it again (${attempt + 1} of ${cfg.tries}).`);
    }
    let tail = '';
    try {
      tail = fs.readFileSync(logPath, 'utf-8').slice(-600).trim();
    } catch {
      /* no log */
    }
    throw new FinderError('slicer', `Bambu Studio did not produce a complete ${path.basename(out)} (exit code ${code}, ${cfg.tries} run${cfg.tries > 1 ? 's' : ''}).${tail ? ' Last output: ' + tail : ''}`);
  }

  /** The numbers the print dialog shows, read from the gcode header. */
  function readEstimate(gcode3mf) {
    const buf = fs.readFileSync(gcode3mf);
    const entries = listZip(buf);
    if (!entries.some((e) => e.name === 'Metadata/plate_1.gcode')) {
      throw new FinderError('slicer', 'The sliced file has no Metadata/plate_1.gcode, so the printer could not run it.');
    }
    const gcode = readByName(buf, 'Metadata/plate_1.gcode', entries).toString('utf-8', 0, 200000);
    const head = gcode.split('; HEADER_BLOCK_END', 1)[0];
    const time = /total estimated time:\s*([^\n;]+)/i.exec(head) || /estimated printing time[^=\n]*=\s*([^\n;]+)/i.exec(head);
    const grams = /total filament weight \[g\]\s*:\s*([\d.]+)/i.exec(head);
    const layers = /total layer number:\s*(\d+)/i.exec(head);
    return {
      time: time ? time[1].trim() : null,
      grams: grams ? Number(grams[1]) : null,
      layers: layers ? Number(layers[1]) : null,
    };
  }

  /**
   * @param {object} p
   * @param {string} p.workspaceDir
   * @param {object} p.detail      normalized detail (site, siteId, title)
   * @param {string} p.relPath     downloaded STL/3MF, workspace-relative
   * @param {string} p.trayType    filament type from the chosen AMS tray, e.g. PLA
   * @param {(m:string)=>void} [p.onProgress]
   */
  async function slice({ workspaceDir, detail, relPath, trayType, onProgress = () => {} }) {
    const gaps = missing();
    if (gaps.length) throw new FinderError('slicer-missing', `Slicing is not set up on this computer. Missing: ${gaps.join('; ')}.`);
    const filament = filamentPresetFor(trayType);
    if (!filament) {
      throw new FinderError('unsupported-filament', `There is no P1S slicing preset for ${trayType || 'this filament'} yet. Load PLA or PETG, or slice it in Bambu Studio.`);
    }

    const dir = modelDir(workspaceDir, detail.site, detail.siteId);
    const src = resolveFileWithin(workspaceDir, relPath, dir);
    const ext = path.extname(src).toLowerCase().slice(1);

    onProgress('Reading the model');
    const mesh = loadMesh(fs.readFileSync(src), ext);
    const raw = bounds(mesh);
    if (!raw) throw new FinderError('unsupported', 'This model is empty.');
    const problem = fitProblem(raw.dims);
    if (problem) throw new FinderError('too-big', problem, { dims: raw.dims });

    const slug = kebab(detail.title, 36);
    const outDir = path.join(workspaceDir, 'renders', 'finder', `${slug}-${crypto.randomBytes(3).toString('hex')}`);
    if (!isReallyInside(path.join(workspaceDir, 'renders'), outDir)) throw new FinderError('path', 'The slicing folder is outside the workspace.');
    fs.mkdirSync(outDir, { recursive: true });

    onProgress('Placing it on the bed');
    const staged = centredOn(mesh, CENTRE, CENTRE);
    const stagedBounds = bounds(staged);
    const stlPath = path.join(outDir, `${slug}.stl`);
    fs.writeFileSync(stlPath, writeBinaryStl(staged));

    const list = path.join(outDir, `${slug}.assemble.json`);
    fs.writeFileSync(
      list,
      JSON.stringify({ plates: [{ plate_name: slug, need_arrange: false, objects: [{ path: stlPath, count: 1, filaments: [1], assemble_index: [1], pos_x: [0], pos_y: [0], pos_z: [0] }] }] }, null, 1)
    );

    const proj = path.join(outDir, `${slug}.3mf`);
    onProgress('Building the Bambu project');
    await runBambu(
      [
        '--load-settings', `${path.join(cfg.presetDir, cfg.machine)};${path.join(cfg.presetDir, cfg.process)}`,
        '--load-filaments', path.join(cfg.presetDir, filament.file),
        '--load-assemble-list', list,
        '--arrange', '0',
        '--export-3mf', path.basename(proj),
        '--outputdir', outDir,
      ],
      proj,
      { cwd: outDir, onNote: onProgress }
    );

    if (cfg.assertStaged && fs.existsSync(cfg.assertStaged)) {
      onProgress('Checking the part sits on the plate');
      const r = await runner.run(cfg.python, [cfg.assertStaged, proj], { cwd: outDir, timeoutMs: 60000 });
      if (r.code !== 0) {
        throw new FinderError('slicer', `The staged project failed the on-plate check: ${(r.stdout + r.stderr).trim().slice(-300) || 'no output'}`);
      }
    }

    const name = slug;
    const gcode = path.join(outDir, `${name}.gcode.3mf`);
    onProgress('Slicing (this takes a minute or two)');
    await runBambu(
      ['--slice', '0', '--arrange', '0', '--export-3mf', path.basename(gcode), '--outputdir', outDir, proj],
      gcode,
      { cwd: outDir, onNote: onProgress }
    );

    onProgress('Checking the result');
    const estimate = readEstimate(gcode);
    return {
      ok: true,
      name,
      gcode3mf: toRel(workspaceDir, gcode),
      estimate,
      filament: { type: filament.type, preset: filament.file },
      dims: stagedBounds.dims,
    };
  }

  return { slice, runBambu, missing, readEstimate, config: cfg };
}

module.exports = { createSlicer, fitProblem, filamentPresetFor, DEFAULTS, BED, FILAMENT_PRESETS };
