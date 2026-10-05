#!/usr/bin/env node
/**
 * Standalone harness for the web port's Flow A refusal path.
 *
 * THE BUG (2026-10-05). The user clicked Make it while the first build was
 * still running. The server answered 409 { error: 'already-running' }. The
 * shim reduced that to `false`, and studio.js turned every `false` into
 * "Couldn't reach the Claude Code terminal — is it running?". Claude was fine;
 * the message was false, and it sent the user hunting for a broken tool.
 *
 * The shim now keeps the refusal on `api.lastSendFailure` as { code, reason },
 * in words a person can act on, and studio.js shows that reason instead.
 *
 * Run: node tests/web-send-refusal.js
 */

'use strict';

const assert = require('assert');
const path = require('node:path');
const fs = require('node:fs');

function fakeFetch(status, body) {
  return async () => ({ status, text: async () => (body == null ? '' : JSON.stringify(body)) });
}

(async () => {
  // api-shim.js is a browser ES module in a CommonJS package, so load its
  // source as a data: module. It has no imports, which is what makes this work.
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'api-shim.js'), 'utf-8');
  const { createApiShim, describeSendFailure } = await import(
    'data:text/javascript;base64,' + Buffer.from(src).toString('base64')
  );

  let checks = 0;
  const toasts = [];
  const api = createApiShim({ onUnsupported: (r) => toasts.push(r) });

  // 1. A build already running is reported as that, with its age.
  globalThis.fetch = fakeFetch(409, { ok: false, error: 'already-running', startedAt: Date.now() - 30000 });
  assert.strictEqual(await api.composerSendToClaude('a curtain rod holder'), false);
  assert.strictEqual(api.lastSendFailure.code, 'already-running');
  assert.match(api.lastSendFailure.reason, /already running/);
  assert.match(api.lastSendFailure.reason, /3\d seconds ago/);
  assert.doesNotMatch(toasts.at(-1), /reach/i, 'a busy server must never read as unreachable');
  checks++;

  // 2. Success clears the previous refusal, so a stale reason is never shown.
  globalThis.fetch = fakeFetch(200, { ok: true, started: true });
  assert.strictEqual(await api.composerSendToClaude('again'), true);
  assert.strictEqual(api.lastSendFailure, null);
  checks++;

  // 3. No answer at all (dropped link, expired Access sign-in) says so.
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const origError = console.error;
  console.error = () => {};
  assert.strictEqual(await api.composerSendToClaude('x'), false);
  console.error = origError;
  assert.strictEqual(api.lastSendFailure.code, 'no-answer');
  assert.match(api.lastSendFailure.reason, /did not answer/);
  checks++;

  // 4. A server-supplied reason (CLI missing) passes through untouched.
  const missing = describeSendFailure({ error: 'not-configured', reason: 'The Claude Code CLI was not found on this machine.' });
  assert.strictEqual(missing.reason, 'The Claude Code CLI was not found on this machine.');
  checks++;

  console.log(`web-send-refusal: ${checks} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
