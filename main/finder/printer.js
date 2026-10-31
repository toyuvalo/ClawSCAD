// main/finder/printer.js — the P1S, through E:\dev-tools\bambu-ctl\bambu_ctl.py.
//
// Three calls and no others:
//   status()    read-only. Parses `bambu_ctl.py status` into state + AMS trays.
//   snapshot()  read-only. One chamber-camera frame.
//   start()     THE ONLY call that moves the printer. It refuses unless
//                 - the printer is IDLE or FINISH with no HMS error, read fresh;
//                 - the caller holds a camera snapshot taken in the last 15 minutes
//                   AND said the bed is clear (true, not truthy);
//                 - the file is a complete .gcode.3mf made by this app, under
//                   <workspace>/renders/finder/.
//               The snapshot token is single use, so one confirmation is one print.
// pause / resume / stop / gcode_line are deliberately not here.
//
// All of it runs through the injected runner. In tests and fixture mode the
// runner is a fake, so nothing here can reach a real printer by accident.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FinderError } = require('./errors.js');
const { isCompleteZip, listZip } = require('./zip.js');
const { isReallyInside } = require('./paths.js');

const DEFAULTS = {
  python: 'python',
  bambuCtl: 'E:/dev-tools/bambu-ctl/bambu_ctl.py',
  statusTimeoutMs: 45000,
  snapshotTimeoutMs: 30000,
  printTimeoutMs: 8 * 60 * 1000,
  statusCacheMs: 8000,
  snapshotValidMs: 15 * 60 * 1000,
};

const READY_STATES = new Set(['IDLE', 'FINISH']);

/** Text printed by `bambu_ctl.py status` -> an object. Unknown lines are ignored. */
function parseStatus(text) {
  const out = { state: null, percent: null, layer: null, totalLayers: null, remainingMin: null, file: null, nozzle: null, wifi: null, trays: [], hms: [], raw: String(text || '') };
  const lines = out.raw.split(/\r?\n/);
  for (const line of lines) {
    let m = /gcode_state:\s*(\S+)\s+percent:\s*(\S+?)%?\s+layer:\s*(\S+?)\/(\S+)\s+remaining:\s*(\S+)\s*min/.exec(line);
    if (m) {
      out.state = m[1] === 'None' ? null : m[1];
      const n = (v) => (Number.isFinite(Number(v)) && v !== 'None' ? Number(v) : null);
      out.percent = n(m[2]);
      out.layer = n(m[3]);
      out.totalLayers = n(m[4]);
      out.remainingMin = n(m[5]);
      continue;
    }
    if ((m = /^file:\s*(.*)$/.exec(line))) {
      out.file = m[1].trim() === '-' ? null : m[1].trim();
      continue;
    }
    if ((m = /^nozzle:\s*(\S+)\s*mm/.exec(line))) {
      out.nozzle = Number(m[1]) || null;
      continue;
    }
    if ((m = /wifi:\s*(\S+)/.exec(line))) {
      out.wifi = m[1];
      continue;
    }
    if ((m = /^\s*AMS(\d+)\s+tray\s+(\d+)\s+\(slot\s+(\d+)\):\s*(.*)$/.exec(line))) {
      const ams = Number(m[1]);
      const tray = Number(m[2]);
      const rest = m[4].trim();
      const base = { ams, tray, slot: Number(m[3]), mapping: ams * 4 + tray };
      if (/^empty$/i.test(rest)) {
        out.trays.push({ ...base, empty: true, type: null, color: null, brand: null, remain: null });
      } else {
        const t = /^(\S+)\s+#([0-9A-Fa-f]{6})[0-9A-Fa-f]{0,2}\s*(.*?)\s*remain=(-?\d+|None)%?\s*$/.exec(rest);
        out.trays.push(
          t
            ? { ...base, empty: false, type: t[1], color: '#' + t[2].toUpperCase(), brand: t[3] && t[3] !== 'None' ? t[3] : null, remain: t[4] === 'None' || Number(t[4]) < 0 ? null : Number(t[4]) }
            : { ...base, empty: false, type: rest.split(/\s+/)[0] || null, color: null, brand: null, remain: null }
        );
      }
      continue;
    }
    if ((m = /^HMS errors:\s*(.*)$/.exec(line))) {
      const v = m[1].trim();
      if (v && v.toLowerCase() !== 'none') {
        try {
          const parsed = JSON.parse(v);
          out.hms = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          out.hms = [v];
        }
      }
    }
  }
  return out;
}

function createPrinter({ runner, config = {}, now = () => Date.now(), randomToken = () => crypto.randomBytes(12).toString('hex') } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  let cached = null; // { at, value }
  const snapshots = new Map(); // token -> { at, file }

  // One bambu_ctl call at a time: each opens its own MQTT session to the printer.
  let chain = Promise.resolve();
  function exclusive(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  function available() {
    const gaps = [];
    if (!fs.existsSync(cfg.bambuCtl)) gaps.push(`bambu_ctl.py (${cfg.bambuCtl})`);
    return gaps;
  }

  async function status({ fresh = false } = {}) {
    if (!fresh && cached && now() - cached.at < cfg.statusCacheMs) return { ...cached.value, cached: true };
    const gaps = available();
    if (gaps.length) throw new FinderError('printer-missing', `The printer tool is not set up on this computer. Missing: ${gaps.join('; ')}.`);
    const r = await exclusive(() => runner.run(cfg.python, [cfg.bambuCtl, 'status'], { timeoutMs: cfg.statusTimeoutMs }));
    if (r.spawnError) throw new FinderError('printer', 'Could not start Python to ask the printer. Is python on the PATH?');
    if (r.timedOut) throw new FinderError('printer', 'The printer did not answer in time. Is it on and on the network?');
    const parsed = parseStatus(r.stdout);
    if (r.code !== 0 && !parsed.state) {
      throw new FinderError('printer', `The printer did not report in. ${(r.stderr || r.stdout).trim().slice(-200) || 'No output.'}`);
    }
    const value = { ok: true, ...parsed, takenAt: now() };
    delete value.raw;
    cached = { at: now(), value };
    return { ...value, cached: false };
  }

  async function snapshot({ outDir }) {
    const gaps = available();
    if (gaps.length) throw new FinderError('printer-missing', `The printer tool is not set up on this computer. Missing: ${gaps.join('; ')}.`);
    fs.mkdirSync(outDir, { recursive: true });
    const token = randomToken();
    const file = path.join(outDir, `bed-${token.slice(0, 8)}.jpg`);
    const r = await exclusive(() => runner.run(cfg.python, [cfg.bambuCtl, 'snapshot', file], { timeoutMs: cfg.snapshotTimeoutMs }));
    if (r.code !== 0 || !fs.existsSync(file)) {
      throw new FinderError('printer', `The camera gave no picture. ${(r.stderr || r.stdout).trim().slice(-200) || ''}`.trim());
    }
    const bytes = fs.readFileSync(file);
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      fs.rmSync(file, { force: true });
      throw new FinderError('printer', 'The camera sent something that is not a picture.');
    }
    const at = now();
    snapshots.set(token, { at, file });
    for (const [k, v] of snapshots) if (at - v.at > cfg.snapshotValidMs) snapshots.delete(k);
    return { ok: true, token, takenAt: at, image: `data:image/jpeg;base64,${bytes.toString('base64')}` };
  }

  /**
   * @param {object} p
   * @param {string} p.gcode3mf     absolute path
   * @param {string} p.rendersDir   <workspace>/renders/finder — the only place a print file may live
   * @param {number} p.mapping      0-based AMS tray for slicer filament 1
   * @param {string} p.name         job name
   * @param {boolean} p.bedClear    must be exactly true
   * @param {string} p.snapshotToken
   * @param {(line:string)=>void} [p.onLine]
   */
  /** Throws unless the bed was looked at (fresh picture) and confirmed clear. Does not consume the token. */
  function checkConfirmation({ bedClear, snapshotToken }) {
    if (bedClear !== true) throw new FinderError('not-confirmed', 'Confirm that the bed is clear before printing.');
    const snap = snapshots.get(snapshotToken);
    if (!snap || now() - snap.at > cfg.snapshotValidMs) {
      throw new FinderError('not-confirmed', 'Take a fresh look at the bed first. The last picture is missing or older than 15 minutes.');
    }
  }

  async function start({ gcode3mf, rendersDir, mapping, name, bedClear, snapshotToken, onLine }) {
    checkConfirmation({ bedClear, snapshotToken });
    if (!Number.isInteger(mapping) || mapping < 0 || mapping > 15) throw new FinderError('bad-request', 'Pick an AMS slot.');
    if (typeof gcode3mf !== 'string' || !/\.gcode\.3mf$/i.test(gcode3mf) || !isReallyInside(rendersDir, gcode3mf)) {
      throw new FinderError('path', 'That file is not a sliced file made by this app.');
    }
    let buf;
    try {
      buf = fs.readFileSync(gcode3mf);
    } catch {
      throw new FinderError('not-found', 'The sliced file is gone. Slice it again.');
    }
    if (!isCompleteZip(buf) || !listZip(buf).some((e) => e.name === 'Metadata/plate_1.gcode')) {
      throw new FinderError('slicer', 'The sliced file is damaged or has no gcode. Slice it again.');
    }

    const gaps = available();
    if (gaps.length) throw new FinderError('printer-missing', `The printer tool is not set up on this computer. Missing: ${gaps.join('; ')}.`);

    // Fresh state, read now — not the cached one from a minute ago.
    const s = await status({ fresh: true });
    if (!READY_STATES.has(s.state)) {
      throw new FinderError('printer-busy', `The printer is ${s.state || 'in an unknown state'}. It must be IDLE or FINISH before a new print starts.`, { state: s.state });
    }
    if (s.hms && s.hms.length) {
      throw new FinderError('printer-error', 'The printer reports a fault (HMS). Clear it on the printer, then try again.', { hms: s.hms });
    }
    const tray = s.trays.find((t) => t.mapping === mapping);
    if (!tray || tray.empty) throw new FinderError('bad-request', 'That AMS slot is empty. Pick a slot with filament in it.');

    snapshots.delete(snapshotToken); // single use
    const safeName = String(name || path.basename(gcode3mf, '.gcode.3mf')).replace(/[^\w .-]/g, '_').slice(0, 60);
    const r = await exclusive(() =>
      runner.run(cfg.python, [cfg.bambuCtl, 'print', gcode3mf, '--ams-mapping', String(mapping), '--name', safeName, '--timeout', '420'], {
        timeoutMs: cfg.printTimeoutMs,
        onLine,
      })
    );
    cached = null;
    if (r.timedOut) throw new FinderError('printer', 'The print command timed out. Check the printer before trying again.');
    const started = r.code === 0 && /print is RUNNING/i.test(r.stdout);
    return { ok: started, code: r.code, started, output: r.stdout.trim().split(/\r?\n/).slice(-12) };
  }

  return { status, snapshot, start, checkConfirmation, available, config: cfg };
}

module.exports = { createPrinter, parseStatus, READY_STATES, DEFAULTS };
