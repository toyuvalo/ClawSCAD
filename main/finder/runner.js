// main/finder/runner.js — the only place Find & Print starts another program.
//
// Two programs, and only two: the Bambu Studio CLI (slicing) and bambu_ctl.py
// (printer status / camera / print). Everything that starts one goes through a
// `runner`, so that:
//   - tests and the offline fixture mode swap in a fake and NEVER start the real
//     slicer or touch the printer (see createFixtureRunner in fixture-runner.js);
//   - we only ever kill the exact PID we started, never a process by name.
//
// A runner has two calls:
//   run(file, args, opts)   -> Promise<{code, stdout, stderr, timedOut}>   short jobs
//   start(file, args, opts) -> handle { pid, exited: Promise<number|null>, kill() }   long jobs
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const MAX_CAPTURE = 1024 * 1024;

function createRunner({ spawnImpl = spawn } = {}) {
  function lowerPriority(child) {
    try {
      if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      /* not allowed or already gone: priority is a courtesy */
    }
  }

  function run(file, args, { cwd, timeoutMs = 60000, env, onLine, belowNormal = false } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(file, args, { cwd, env: env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ code: null, stdout: '', stderr: String((err && err.message) || err), timedOut: false, spawnError: true });
        return;
      }
      if (belowNormal) lowerPriority(child);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let pending = '';
      const feed = (chunk, isErr) => {
        const text = chunk.toString('utf-8');
        if (isErr) stderr = (stderr + text).slice(-MAX_CAPTURE);
        else stdout = (stdout + text).slice(-MAX_CAPTURE);
        if (onLine) {
          pending += text;
          let i;
          while ((i = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, i).replace(/\r$/, '');
            pending = pending.slice(i + 1);
            if (line) onLine(line);
          }
        }
      };
      child.stdout.on('data', (c) => feed(c, false));
      child.stderr.on('data', (c) => feed(c, true));
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* gone */
        }
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: stderr || String(err.message), timedOut, spawnError: true });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (onLine && pending.trim()) onLine(pending.trim());
        resolve({ code, stdout, stderr, timedOut });
      });
    });
  }

  function start(file, args, { cwd, logPath, env, belowNormal = true } = {}) {
    const out = logPath ? fs.openSync(logPath, 'w') : 'ignore';
    const child = spawnImpl(file, args, { cwd, env: env || process.env, windowsHide: true, stdio: ['ignore', out, out] });
    if (typeof out === 'number') {
      // The child holds its own copy of the descriptor; ours can close now.
      child.on('spawn', () => {
        try {
          fs.closeSync(out);
        } catch {
          /* already closed */
        }
      });
    }
    if (belowNormal) lowerPriority(child);
    let exitCode;
    const exited = new Promise((resolve) => {
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        exitCode = code;
        resolve(code);
      });
    });
    return {
      pid: child.pid,
      exited,
      exitCode: () => exitCode,
      kill() {
        try {
          child.kill();
        } catch {
          /* gone */
        }
      },
    };
  }

  return { run, start };
}

module.exports = { createRunner };
