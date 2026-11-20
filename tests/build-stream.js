#!/usr/bin/env node
/**
 * Standalone harness for main/build-stream.js — the v0.9 live build chat.
 *
 * THE BUG (2026-11-19). The headless build ran `claude -p --output-format
 * text`, which prints nothing until Claude exits. For up to ten minutes the
 * Studio said only "Building…". The build now streams stream-json, and this
 * parser turns it into chat items + progress. These checks pin the contract
 * the chat panel relies on.
 *
 * Run: node tests/build-stream.js
 */

'use strict';

const assert = require('assert');
const { createBuildParser, parseOptions, bboxFrom, describeTool } = require('../main/build-stream.js');

let checks = 0;
const line = (o) => `${JSON.stringify(o)}\n`;
const SID = '2220d68b-bdbc-4679-b968-c48fc0f7a6fc';

function run(chunks) {
  const items = [];
  const progress = [];
  let session = null;
  const p = createBuildParser({
    onItem: (i) => items.push(i),
    onProgress: (x) => progress.push(x),
    onSession: (s) => (session = s),
  });
  for (const c of chunks) p.feed(c);
  const result = p.end();
  return { items, progress, session, result, parser: p };
}

// A realistic build: init → comment → write .scad → measure → render → fix → final text with options.
const build = [
  line({ type: 'system', subtype: 'hook_started', session_id: SID }),
  line({ type: 'system', subtype: 'init', session_id: SID, tools: [] }),
  line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will write holed-cube.scad now.' }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'C:\\ws\\holed-cube.scad', content: 'cube(20);' } }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'File created' }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'openscad -o x.stl --summary all --summary-file - holed-cube.scad' } }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: '{"geometry":{"bounding_box":{"size": [20.0001, 20, 19.96]}}}' }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'mcp__openscad__render_scad_png', input: { cameraPreset: 'isometric' } }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't4', name: 'Write', input: { file_path: 'holed-cube-v2.scad' } }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't4', content: 'File created' }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done. It is 20 mm.\nOPTIONS: Chamfer the edges | Make the hole 8 mm | Add a slot' }] } }),
  line({ type: 'result', subtype: 'success', is_error: false, session_id: SID, result: 'Done.' }),
];

// 1. Lines split across chunk boundaries still parse (stdout arrives in pieces).
{
  const joined = build.join('');
  const chunks = [];
  for (let i = 0; i < joined.length; i += 37) chunks.push(joined.slice(i, i + 37));
  const a = run(chunks);
  const b = run(build);
  assert.strictEqual(a.items.length, b.items.length);
  assert.ok(a.items.length > 0);
  checks++;
}

const r = run(build);

// 2. The session id is captured for --resume.
assert.strictEqual(r.session, SID);
checks++;

// 3. Comments become assistant items; thinking blocks add nothing.
const texts = r.items.filter((i) => i.kind === 'assistant');
assert.strictEqual(texts.length, 2);
assert.strictEqual(texts[0].text, 'I will write holed-cube.scad now.');
checks++;

// 4. The OPTIONS line is lifted out of the text into clickable options.
assert.deepStrictEqual(texts[1].options, ['Chamfer the edges', 'Make the hole 8 mm', 'Add a slot']);
assert.ok(!/OPTIONS/.test(texts[1].text));
checks++;

// 5. Every .scad write is an iteration, numbered in order.
const writes = r.items.filter((i) => i.kind === 'step' && i.file);
assert.deepStrictEqual(writes.map((w) => [w.file, w.iteration]), [['holed-cube.scad', 1], ['holed-cube-v2.scad', 2]]);
checks++;

// 6. An OpenSCAD --summary result reports the measured size on its step.
const done = r.items.filter((i) => i.kind === 'step-done');
assert.ok(done.some((d) => d.summary === 'Size 20 × 20 × 20 mm'), JSON.stringify(done));
checks++;

// 7. A render's image reaches the chat, linked to its step.
const imgs = r.items.filter((i) => i.kind === 'image');
assert.strictEqual(imgs.length, 1);
assert.strictEqual(imgs[0].mime, 'image/png');
assert.ok(imgs[0].ref);
checks++;

// 8. Progress only ever goes up, and ends at 100.
for (let i = 1; i < r.progress.length; i++) assert.ok(r.progress[i].pct >= r.progress[i - 1].pct, `pct went down at ${i}`);
assert.strictEqual(r.progress[r.progress.length - 1].pct, 100);
assert.strictEqual(r.progress[r.progress.length - 1].phase, 'done');
checks++;

// 8b. A fix written after "wrapping up" must not pull the bar backwards
//     (fixing's floor is below wrapping's).
{
  const w = run([
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Write', input: { file_path: 'a.scad' } }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'openscad -o a.stl a.scad' } }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looks right, one tweak.' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c', name: 'Write', input: { file_path: 'a2.scad' } }] } }),
  ]);
  for (let i = 1; i < w.progress.length; i++) assert.ok(w.progress[i].pct >= w.progress[i - 1].pct, `pct went down at ${i}`);
  checks++;
}

// 9. A second write after a check reads as fixing, with the iteration in the label.
assert.ok(r.progress.some((p) => /iteration 2/.test(p.label)), r.progress.map((p) => p.label).join(' | '));
checks++;

// 10. A final question puts the build in "waiting", not "done".
{
  const q = run([
    line({ type: 'system', subtype: 'init', session_id: SID }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Which way?\nQUESTION: Should the hole go through the side or the top?\nOPTIONS: Side | Top' }] } }),
    line({ type: 'result', subtype: 'success', is_error: false, session_id: SID }),
  ]);
  const a = q.items.find((i) => i.kind === 'assistant');
  assert.strictEqual(a.question, 'Should the hole go through the side or the top?');
  assert.deepStrictEqual(a.options, ['Side', 'Top']);
  assert.strictEqual(q.result.waiting, true);
  assert.strictEqual(q.progress[q.progress.length - 1].phase, 'waiting');
  checks++;
}

// 11. An error result is shown, and its text is the failure reason (not a JSON line).
{
  const LIMIT = "You've hit your session limit · resets 5:40pm";
  const e = run([line({ type: 'result', subtype: 'success', is_error: true, result: LIMIT, session_id: SID })]);
  assert.strictEqual(e.result.failed, true);
  assert.strictEqual(e.result.errorText, LIMIT);
  assert.ok(e.items.some((i) => i.kind === 'error' && i.text === LIMIT));
  checks++;
}

// 12. A non-JSON line (a crash, a plain message) is shown as said, never dropped.
{
  const n = run(['Error: spawn EPERM\n']);
  assert.deepStrictEqual(n.items.map((i) => [i.kind, i.text]), [['system', 'Error: spawn EPERM']]);
  checks++;
}

// 13. A failed tool shows the first line of its error on the step.
{
  const f = run([
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'openscad -o a.stl a.scad' } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'ERROR: Parser error in line 3\nmore' }] } }),
  ]);
  const d = f.items.find((i) => i.kind === 'step-done');
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.summary, 'ERROR: Parser error in line 3');
  checks++;
}

// 14. The iteration count carries over a resumed turn (shared state).
{
  const items = [];
  const p1 = createBuildParser({ onItem: (i) => items.push(i) });
  p1.feed(build.join(''));
  p1.end();
  const p2 = createBuildParser({ state: p1.state, onItem: (i) => items.push(i) });
  p2.feed(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'y', name: 'Edit', input: { file_path: 'c.scad' } }] } }));
  const last = items.filter((i) => i.kind === 'step' && i.file).pop();
  assert.strictEqual(last.iteration, 3);
  // ids stay unique across turns, or the client would drop items as duplicates
  const ids = items.filter((i) => i.id).map((i) => i.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  checks++;
}

// 15. Pure helpers.
assert.deepStrictEqual(parseOptions('a\n**OPTIONS:** x | y'), { text: 'a', options: ['x', 'y'], question: null });
assert.strictEqual(bboxFrom('nothing here'), null);
assert.strictEqual(describeTool('Read', { file_path: '/w/active.scad' }).label, 'Reading active.scad');
assert.strictEqual(describeTool('Bash', { command: 'ls -la' }).phase, null);
checks++;

console.log(`build-stream: ${checks} checks passed`);
