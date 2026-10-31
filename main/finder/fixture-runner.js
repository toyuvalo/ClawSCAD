// main/finder/fixture-runner.js — a stand-in for the Bambu Studio CLI and
// bambu_ctl.py. Switched on ONLY by CLAWSCAD_FINDER_FIXTURES=<dir>.
//
// It starts NO process. It answers from the recorded text in tests/fixtures/finder/
// and writes small valid files where the real tools would. Anything it does not
// recognise throws, loudly: a test that reaches for a real program fails instead
// of running it. Every call is appended (one JSON line) to the file named by
// CLAWSCAD_FINDER_RUNNER_LOG, so a spec can assert what would have been run —
// for example that `print` was sent exactly once, with the right tray.
//
//   CLAWSCAD_FINDER_PRINTER_STATE=RUNNING  makes `status` answer the busy printer.
'use strict';

const fs = require('fs');
const path = require('path');
const { createZip } = require('./zip.js');
const { FinderError } = require('./errors.js');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

function createFixtureRunner(dir, { logPath, env = process.env } = {}) {
  const calls = [];
  logPath = logPath || env.CLAWSCAD_FINDER_RUNNER_LOG;
  const record = (file, args) => {
    const entry = { file: path.basename(String(file)), args: args.map(String) };
    calls.push(entry);
    if (logPath) {
      try {
        fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
      } catch {
        /* the log is a convenience */
      }
    }
  };
  const readText = (name) => fs.readFileSync(path.join(dir, name), 'utf-8');
  const optionAfter = (args, flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };

  function refuse(file, args) {
    throw new FinderError('fixture', `The fixture runner refused to start ${path.basename(String(file))} ${args.join(' ')}. Fixture mode never starts a real program.`);
  }

  async function run(file, args = [], opts = {}) {
    record(file, args);
    const joined = args.join(' ');
    if (/bambu_ctl\.py$/i.test(String(args[0] || ''))) {
      const sub = args[1];
      if (sub === 'status') {
        const name = String(env.CLAWSCAD_FINDER_PRINTER_STATE || 'IDLE').toUpperCase() === 'RUNNING' ? 'bambu-status-running.txt' : 'bambu-status-idle.txt';
        return { code: 0, stdout: readText(name), stderr: '', timedOut: false };
      }
      if (sub === 'snapshot') {
        fs.mkdirSync(path.dirname(args[2]), { recursive: true });
        fs.writeFileSync(args[2], JPEG);
        return { code: 0, stdout: `saved ${args[2]} (${JPEG.length} bytes)\n`, stderr: '', timedOut: false };
      }
      if (sub === 'print') {
        if (env.CLAWSCAD_FINDER_HOLD) {
          const reason = String(env.CLAWSCAD_FINDER_HOLD);
          return { code: 3, stdout: `REFUSED, nothing sent: start hold is on (${reason}). Only Yuval lifts it: bambu_ctl.py release\n`, stderr: '', timedOut: false };
        }
        const lines = [`starting print: ${path.basename(args[2])}  ams_mapping=[${optionAfter(args, '--ams-mapping')}]`, '  [2s] state=PREPARE percent=0 layer=0', '  [9s] state=RUNNING percent=0 layer=1', 'print is RUNNING (layer >= 1)'];
        if (opts.onLine) lines.forEach((l) => opts.onLine(l));
        return { code: 0, stdout: lines.join('\n') + '\n', stderr: '', timedOut: false };
      }
      return refuse(file, args);
    }
    if (/assert_staged\.py$/i.test(String(args[0] || ''))) {
      return { code: 0, stdout: `ok   ${args[1]}\n`, stderr: '', timedOut: false };
    }
    return refuse(file, args.length ? args : [joined]);
  }

  function start(file, args = [], opts = {}) {
    record(file, args);
    if (!/bambu-studio/i.test(String(file))) return refuse(file, args);
    const outDir = optionAfter(args, '--outputdir');
    const outName = optionAfter(args, '--export-3mf');
    if (!outDir || !outName) return refuse(file, args);
    const slicing = args.includes('--slice');
    const entries = slicing
      ? [
          { name: '[Content_Types].xml', data: '<Types/>' },
          {
            name: 'Metadata/plate_1.gcode',
            data: '; HEADER_BLOCK_START\n; model printing time: 11m 2s; total estimated time: 13m 40s\n; total layer number: 100\n; total filament weight [g] : 7.25\n; HEADER_BLOCK_END\nG28\n',
          },
        ]
      : [
          { name: '[Content_Types].xml', data: '<Types/>' },
          { name: '3D/3dmodel.model', data: '<model/>' },
          { name: 'Metadata/project_settings.config', data: '{}' },
        ];
    const target = path.join(outDir, outName);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(target, createZip(entries));
    if (opts.logPath) fs.writeFileSync(opts.logPath, 'fixture slicer: wrote ' + outName + '\n');
    return { pid: 0, exited: Promise.resolve(0), exitCode: () => 0, kill() {} };
  }

  return { run, start, calls };
}

module.exports = { createFixtureRunner };
