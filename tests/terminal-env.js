#!/usr/bin/env node
/**
 * Standalone harness (no Electron) for main/terminal-env.js — the environment
 * both workspace terminals get. CLAUDE.md tells Claude to run
 * "$OPENSCAD_BINARY", so the terminal must export the binary the app renders
 * with, and must still carry everything else from the parent environment.
 *
 * Run: node tests/terminal-env.js
 */

const assert = require('assert');
const path = require('path');

const { terminalEnv } = require(path.join(__dirname, '..', 'main', 'terminal-env.js'));

const base = { PATH: '/usr/bin', HOME: '/home/u', OPENSCAD_BINARY: '/old/openscad' };
const bin = 'C:\\Program Files\\ClawSCAD\\resources\\openscad\\openscad.exe';
const env = terminalEnv(base, bin);

// The app's own binary wins, so Claude's checks match the app's renders.
assert.strictEqual(env.OPENSCAD_BINARY, bin);
assert.strictEqual(env.COLORTERM, 'truecolor');
// The rest of the parent environment passes through untouched.
assert.strictEqual(env.PATH, '/usr/bin');
assert.strictEqual(env.HOME, '/home/u');
// The caller's object is not mutated (it is process.env in the app).
assert.strictEqual(base.OPENSCAD_BINARY, '/old/openscad');
assert.strictEqual(base.COLORTERM, undefined);

// With no bundled copy, getOpenscadBin() falls back to a bare 'openscad'.
assert.strictEqual(terminalEnv({}, 'openscad').OPENSCAD_BINARY, 'openscad');

console.log('terminal-env: 7 assertions passed');
