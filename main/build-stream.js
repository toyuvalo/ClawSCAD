// main/build-stream.js — turns `claude -p --output-format stream-json` into a
// chat the user can watch.
//
// Before v0.9 the headless build ran with `--output-format text`, which prints
// NOTHING until Claude exits. The Studio could only say "Building…" for up to
// ten minutes. stream-json emits one JSON object per line as the run happens:
// each assistant text block, each tool call, each tool result. This module
// reads those lines and produces two things:
//
//   1. chat items — what Claude said, which step it took, the render it made;
//   2. progress  — a phase, a percentage that only goes up, and the iteration
//      count (how many times Claude has written a .scad in this session).
//
// It is plain CommonJS with no Electron or DOM dependency, so web/server.js
// and the node harness (tests/build-stream.js) both load it directly.

'use strict';

const path = require('node:path');

// The phases, in the order a normal build walks them. `pct` is the FLOOR the
// bar jumps to when the phase starts; the client creeps it forward inside the
// phase so a long step still shows motion.
const PHASES = {
  starting: { pct: 3, label: 'Starting Claude' },
  reading: { pct: 12, label: 'Reading the brief and the current model' },
  planning: { pct: 20, label: 'Planning the design' },
  writing: { pct: 40, label: 'Writing the model' },
  checking: { pct: 62, label: 'Checking the result' },
  fixing: { pct: 72, label: 'Fixing what the check found' },
  wrapping: { pct: 90, label: 'Wrapping up' },
  waiting: { pct: 100, label: 'Waiting for your answer' },
  done: { pct: 100, label: 'Done' },
  failed: { pct: 100, label: 'Stopped' },
};

const MAX_IMAGE_BYTES = 600 * 1024; // base64 characters; a 400x300 PNG is ~30 KB
const MAX_DETAIL = 600;

function isScad(p) {
  return typeof p === 'string' && /\.scad$/i.test(p);
}

function base(p) {
  return typeof p === 'string' && p ? path.basename(p.replace(/\\/g, '/')) : '';
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function isOpenscadCommand(cmd) {
  return /openscad/i.test(String(cmd || ''));
}

/**
 * A plain-language label for one tool call, plus the phase it implies.
 * Returns { label, phase, scadFile }.
 */
function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const file = i.file_path || i.path || i.notebook_path || '';
  switch (name) {
    case 'Read':
      return { label: `Reading ${base(file) || 'a file'}`, phase: 'reading' };
    case 'Glob':
    case 'Grep':
    case 'LS':
      return { label: 'Looking through the workspace', phase: 'reading' };
    case 'Write':
      return {
        label: isScad(file) ? `Writing ${base(file)}` : `Writing ${base(file) || 'a file'}`,
        phase: isScad(file) ? 'writing' : null,
        scadFile: isScad(file) ? base(file) : null,
      };
    case 'Edit':
    case 'MultiEdit':
      return {
        label: `Editing ${base(file) || 'a file'}`,
        phase: isScad(file) ? 'writing' : null,
        scadFile: isScad(file) ? base(file) : null,
      };
    case 'Bash': {
      const cmd = String(i.command || '');
      if (isOpenscadCommand(cmd)) {
        const what = /--summary|\.stl|\.3mf/i.test(cmd)
          ? 'Measuring it with OpenSCAD'
          : /\.png/i.test(cmd)
            ? 'Rendering a picture with OpenSCAD'
            : 'Running OpenSCAD';
        return { label: what, phase: 'checking' };
      }
      return { label: `Running ${clip(i.description || cmd.split(/\r?\n/)[0], 80)}`, phase: null };
    }
    case 'TodoWrite':
      return { label: 'Updating its plan', phase: 'planning' };
    case 'ToolSearch':
      return { label: 'Getting a tool ready', phase: null };
    default:
      if (/render_scad_png$/.test(name)) {
        const view = i.cameraPreset ? ` (${i.cameraPreset})` : '';
        return { label: `Rendering a preview${view}`, phase: 'checking' };
      }
      if (/export_scad_stl$/.test(name)) return { label: 'Exporting an STL to check it', phase: 'checking' };
      return { label: `Using ${String(name || 'a tool').replace(/^mcp__[^_]+__/, '')}`, phase: null };
  }
}

/**
 * Pulls the clickable answers out of an assistant message. The system prompt
 * asks Claude to end with `OPTIONS: a | b | c`, and to put a real question on
 * a `QUESTION:` line. Both lines are removed from the text the chat shows.
 */
function parseOptions(text) {
  const lines = String(text || '').split(/\r?\n/);
  let options = [];
  let question = null;
  const kept = [];
  for (const line of lines) {
    const opt = line.match(/^\s*\**\s*OPTIONS\s*:\**\s*(.+)$/i);
    if (opt) {
      options = opt[1]
        .split('|')
        .map((s) => s.replace(/^[\s*`"-]+|[\s*`"]+$/g, '').trim())
        .filter(Boolean)
        .slice(0, 6);
      continue;
    }
    const q = line.match(/^\s*\**\s*QUESTION\s*:\**\s*(.+)$/i);
    if (q) {
      question = q[1].trim();
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n').trim(), options, question };
}

/** `"size": [40, 25, 12]` from an OpenSCAD --summary → "40 × 25 × 12 mm". */
function bboxFrom(text) {
  const m = String(text || '').match(/"size"\s*:\s*\[\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*\]/);
  if (!m) return null;
  const f = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : v;
  };
  return `${f(m[1])} × ${f(m[2])} × ${f(m[3])} mm`;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function resultImages(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const c of content) {
    if (!c || c.type !== 'image') continue;
    const src = c.source || {};
    const data = src.data || c.data;
    const mime = src.media_type || c.mimeType || 'image/png';
    if (typeof data === 'string' && data.length <= MAX_IMAGE_BYTES) out.push({ mime, data });
  }
  return out;
}

/**
 * The parser. Feed it raw stdout chunks; it calls onItem(item) for every chat
 * item and onProgress(progress) whenever the phase or percentage moves.
 *
 * `state` carries over between turns of one session (a reply resumes the same
 * Claude session, and the iteration count must keep counting).
 */
function createBuildParser({ onItem = () => {}, onProgress = () => {}, onSession = () => {}, state } = {}) {
  const s = state || { iteration: 0, steps: 0, phase: 'starting', pct: 0, checked: false, seq: 0 };
  let buf = '';
  const pending = new Map(); // tool_use_id -> step item
  let lastText = null;

  const now = () => Date.now();
  const nextId = () => `i${++s.seq}`;

  function emit(item) {
    item.id = item.id || nextId();
    item.t = item.t || now();
    onItem(item);
    return item;
  }

  function progress(phase) {
    if (phase && PHASES[phase]) {
      s.phase = phase;
      s.pct = Math.max(s.pct || 0, PHASES[phase].pct);
    }
    const label =
      s.phase === 'fixing' || (s.phase === 'writing' && s.iteration > 1)
        ? `Fixing it — iteration ${s.iteration}`
        : (PHASES[s.phase] || PHASES.starting).label;
    onProgress({ phase: s.phase, label, pct: s.pct, iteration: s.iteration, steps: s.steps });
  }

  function onAssistant(msg) {
    const content = (msg && msg.message && msg.message.content) || [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && block.text && block.text.trim()) {
        const parsed = parseOptions(block.text);
        lastText = emit({
          kind: 'assistant',
          text: parsed.text,
          options: parsed.options,
          question: parsed.question,
        });
        if (s.phase === 'starting' || s.phase === 'reading') progress('planning');
        else if (s.checked && s.phase !== 'writing' && s.phase !== 'fixing') progress('wrapping');
      } else if (block.type === 'tool_use') {
        s.steps += 1;
        const d = describeTool(block.name, block.input);
        const item = { kind: 'step', tool: block.name, text: d.label, status: 'running' };
        if (block.name === 'TodoWrite' && block.input && Array.isArray(block.input.todos)) {
          item.todos = block.input.todos.slice(0, 12).map((t) => ({
            text: clip(t.content || t.activeForm || '', 120),
            status: t.status || 'pending',
          }));
        }
        if (block.name === 'Bash' && block.input && block.input.command) item.detail = clip(block.input.command, MAX_DETAIL);
        if (d.scadFile) {
          s.iteration += 1;
          item.file = d.scadFile;
          item.iteration = s.iteration;
        }
        pending.set(block.id, emit(item));
        if (d.scadFile) progress(s.iteration > 1 && s.checked ? 'fixing' : 'writing');
        else if (d.phase === 'checking') {
          s.checked = true;
          progress('checking');
        } else if (d.phase) {
          // Never walk the bar backwards: reading after writing is still "checking".
          const order = Object.keys(PHASES);
          if (order.indexOf(d.phase) > order.indexOf(s.phase)) progress(d.phase);
          else progress();
        } else progress();
      }
    }
  }

  function onUser(msg) {
    const content = (msg && msg.message && msg.message.content) || [];
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue;
      const step = pending.get(block.tool_use_id);
      pending.delete(block.tool_use_id);
      const text = resultText(block.content);
      const ok = !block.is_error;
      const update = { kind: 'step-done', ref: step ? step.id : null, ok };
      const size = bboxFrom(text);
      if (size) update.summary = `Size ${size}`;
      if (!ok) update.summary = clip(text.split(/\r?\n/).find((l) => l.trim()) || 'failed', 200);
      if (text && (!ok || (step && step.tool === 'Bash'))) update.detail = clip(text, MAX_DETAIL);
      emit(update);
      for (const img of resultImages(block.content)) {
        emit({ kind: 'image', ref: step ? step.id : null, mime: img.mime, data: img.data, caption: step ? step.text : 'Preview' });
      }
    }
  }

  function onResult(msg) {
    const failed = msg.is_error || (msg.subtype && msg.subtype !== 'success');
    // The final assistant text already reached the chat as its own item; the
    // result's `result` field repeats it. Only an error result says something new.
    if (failed) {
      emit({ kind: 'error', text: clip(msg.result || msg.subtype || 'Claude stopped with an error.', 500) });
    }
    const waiting = !failed && lastText && (lastText.question || /\?\s*$/.test(lastText.text || ''));
    progress(failed ? 'failed' : waiting ? 'waiting' : 'done');
    return {
      failed,
      waiting: Boolean(waiting),
      sessionId: msg.session_id || null,
      errorText: failed ? clip(msg.result || msg.subtype || '', 300) || null : null,
    };
  }

  let resultInfo = null;

  function handle(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.session_id) onSession(obj.session_id);
    switch (obj.type) {
      case 'system':
        if (obj.subtype === 'init') progress(s.phase === 'starting' ? 'reading' : null);
        break;
      case 'assistant':
        onAssistant(obj);
        break;
      case 'user':
        onUser(obj);
        break;
      case 'result':
        resultInfo = onResult(obj);
        break;
      default:
        break;
    }
  }

  function feedLine(line) {
    const t = line.trim();
    if (!t) return;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      // Not JSON: a crash message, a "session limit" line. Show it as said.
      emit({ kind: 'system', text: clip(t, 400) });
      return;
    }
    handle(obj);
  }

  return {
    state: s,
    feed(chunk) {
      buf += String(chunk);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        feedLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    end() {
      if (buf.trim()) feedLine(buf);
      buf = '';
      return resultInfo;
    },
    get result() {
      return resultInfo;
    },
    get lastAssistant() {
      return lastText;
    },
  };
}

/**
 * Appended to Claude's system prompt for every Studio build. It is what makes
 * the chat worth reading: short narration, a visible check, and clickable
 * answers instead of a dead end.
 */
const BUILD_SYSTEM_PROMPT = [
  'You are running headless inside ClawSCAD Studio. The user watches your messages live in a chat panel,',
  'and can reply after your turn ends — a reply resumes this same session.',
  '',
  '- Before each major step, write ONE short plain sentence saying what you are about to do and why.',
  '- Do not stop to ask a question unless the part genuinely cannot be made without the answer. Otherwise',
  '  pick sensible values, say which assumptions you made, and build it.',
  '- Check your work: measure the bounding box with `openscad -o <name>.stl --summary all --summary-file - <file>.scad`',
  '  and look at it with the render_scad_png tool (400 x 300, two camera presets). Fix what you find in a NEW file.',
  '- End your final message with one line `OPTIONS: <a> | <b> | <c>` — two to four short next steps the user can',
  '  click, such as variations or fixes. If you need an answer, put the question on its own `QUESTION: ...` line',
  '  and the possible answers on the OPTIONS line.',
].join('\n');

module.exports = {
  PHASES,
  createBuildParser,
  describeTool,
  parseOptions,
  bboxFrom,
  BUILD_SYSTEM_PROMPT,
};
