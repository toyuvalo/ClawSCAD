#!/usr/bin/env node
/**
 * Standalone harness for the reason a failed make reports.
 *
 * THE BUG (2026-10-10). Two builds hit the Claude session limit. Claude Code
 * printed "You've hit your session limit · resets 5:40pm" and exited 1. The
 * Studio view showed only "The build exited 1 without writing a model", so the
 * real reason was invisible. The done event now carries Claude's last line.
 *
 * Run: node tests/web-make-reason.js
 */

'use strict';

const assert = require('assert');
const { makeFailureReason } = require('../web/server.js');

let checks = 0;
const LIMIT = "You've hit your session limit · resets 5:40pm (America/Toronto)";

// 1. A failed run with no model reports Claude's last non-empty line.
assert.strictEqual(makeFailureReason(1, null, `starting\r\n${LIMIT}\n\n`), LIMIT);
checks++;

// 2. A successful run never reports a reason, even with output.
assert.strictEqual(makeFailureReason(0, null, LIMIT), null);
checks++;

// 3. A run that wrote a model is not a failure, whatever the exit code.
assert.strictEqual(makeFailureReason(1, 'part.scad', LIMIT), null);
checks++;

// 4. A failed run that printed nothing falls back to the exit-code message.
assert.strictEqual(makeFailureReason(1, null, '  \n'), null);
checks++;

// 5. A very long line is capped so the toast stays readable.
assert.strictEqual(makeFailureReason(1, null, 'x'.repeat(1000)).length, 300);
checks++;

console.log(`web-make-reason: ${checks} checks passed`);
