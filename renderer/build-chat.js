// renderer/build-chat.js — the live build chat (v0.9).
//
// Shows what Claude is doing while it builds a model: a progress bar with the
// current phase and iteration, every short comment Claude makes, every step it
// takes (reading, writing the .scad, measuring, rendering), the preview
// renders it looks at, and the options it offers at the end. A reply box
// answers its questions or asks for a change — the server resumes the SAME
// Claude session, so it keeps its context.
//
// One module for both shells. The web port passes its fetch shim; the desktop
// app passes the same shim pointed at the local studio server (the "link"),
// plus a hook that opens the session in its real terminal.
//
// Required api: makeSession(), makeReply(text), cancelMake(), makeNew(),
//               onMakeChat(cb), onMakeProgress(cb), onMakeEvent(cb).
// Optional opts: onOpenFile(file)        — open a made .scad
//                onContinueInTerminal(id) — desktop only: resume in the pty
//                assetBase                — prefix for nothing yet; reserved

const ICONS = {
  Read: '📄',
  Glob: '🔎',
  Grep: '🔎',
  LS: '🔎',
  Write: '✏️',
  Edit: '✏️',
  MultiEdit: '✏️',
  Bash: '⚙️',
  TodoWrite: '🗒️',
};

function toolIcon(name) {
  if (ICONS[name]) return ICONS[name];
  if (/render_scad_png$/.test(name || '')) return '🖼️';
  if (/export_scad_stl$/.test(name || '')) return '📦';
  return '•';
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A very small, safe markdown subset: paragraphs, `- ` lists, **bold**,
 * `code`. Builds DOM nodes — never innerHTML with model text in it.
 */
function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const blocks = String(text || '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const isList = lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l) || !l.trim());
    if (isList && lines.some((l) => l.trim())) {
      const ul = el('ul', 'bc-md-list');
      for (const l of lines) {
        if (!l.trim()) continue;
        const li = el('li');
        inline(li, l.replace(/^\s*([-*]|\d+\.)\s+/, ''));
        ul.append(li);
      }
      frag.append(ul);
    } else if (/^```/.test(block.trim())) {
      frag.append(el('pre', 'bc-md-pre', block.replace(/^```\w*\n?|```$/g, '')));
    } else {
      const p = el('p', 'bc-md-p');
      lines.forEach((l, i) => {
        if (i) p.append(document.createElement('br'));
        inline(p, l.replace(/^#+\s*/, ''));
      });
      frag.append(p);
    }
  }
  return frag;
}

function inline(parent, text) {
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('**')) parent.append(el('strong', null, tok.slice(2, -2)));
    else parent.append(el('code', 'bc-md-code', tok.slice(1, -1)));
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

export function mountBuildChat({ api, onOpenFile, onContinueInTerminal, title = 'Claude', host } = {}) {
  if (!api || typeof api.makeSession !== 'function') return null;
  const doc = document;
  const body = doc.body;

  let session = null; // { id, sessionId, status, items, progress, lastFile }
  let running = false;
  let open = false;
  let progress = null;
  let progressAt = Date.now();
  let unread = 0;
  let enabled = true;
  const nodes = new Map(); // item id -> element

  // ── DOM ────────────────────────────────────────────────────────────────
  const root = el('section', 'bc');
  root.id = 'build-chat';
  root.setAttribute('aria-label', 'Build chat');
  root.dataset.state = 'empty';
  root.hidden = true;

  // The collapsed pill: always visible while a build exists.
  const pill = el('button', 'bc-pill');
  pill.type = 'button';
  pill.id = 'build-chat-pill';
  pill.setAttribute('aria-controls', 'build-chat-panel');
  pill.setAttribute('aria-expanded', 'false');
  const pillDot = el('span', 'bc-dot');
  const pillText = el('span', 'bc-pill-text', 'Claude');
  const pillBar = el('span', 'bc-pill-bar');
  const pillFill = el('span', 'bc-pill-fill');
  pillBar.append(pillFill);
  const pillBadge = el('span', 'bc-badge');
  pillBadge.hidden = true;
  pill.append(pillDot, pillText, pillBar, pillBadge);

  const panel = el('div', 'bc-panel');
  panel.id = 'build-chat-panel';
  panel.hidden = true;

  const head = el('header', 'bc-head');
  const headTitle = el('div', 'bc-title');
  const headDot = el('span', 'bc-dot');
  const headName = el('span', 'bc-name', title);
  const headStatus = el('span', 'bc-status', '');
  headTitle.append(headDot, headName, headStatus);
  const headActions = el('div', 'bc-head-actions');
  const stopBtn = el('button', 'bc-hbtn bc-stop', 'Stop');
  stopBtn.type = 'button';
  stopBtn.title = 'Stop this turn';
  const termBtn = el('button', 'bc-hbtn', 'Open in terminal');
  termBtn.type = 'button';
  termBtn.title = 'Continue this exact Claude session in the desktop terminal, with full control';
  termBtn.hidden = typeof onContinueInTerminal !== 'function';
  const newBtn = el('button', 'bc-hbtn', 'New chat');
  newBtn.type = 'button';
  newBtn.title = 'Start a new conversation — the next Make it begins fresh';
  const minBtn = el('button', 'bc-hbtn bc-min', '—');
  minBtn.type = 'button';
  minBtn.title = 'Minimise';
  minBtn.setAttribute('aria-label', 'Minimise the build chat');
  headActions.append(stopBtn, termBtn, newBtn, minBtn);
  head.append(headTitle, headActions);

  const prog = el('div', 'bc-progress');
  const progTrack = el('div', 'bc-track');
  progTrack.setAttribute('role', 'progressbar');
  progTrack.setAttribute('aria-valuemin', '0');
  progTrack.setAttribute('aria-valuemax', '100');
  const progFill = el('div', 'bc-fill');
  progTrack.append(progFill);
  const progMeta = el('div', 'bc-progress-meta');
  const progLabel = el('span', 'bc-progress-label', '');
  const progStats = el('span', 'bc-progress-stats', '');
  progMeta.append(progLabel, progStats);
  prog.append(progTrack, progMeta);

  const feed = el('div', 'bc-feed');
  feed.setAttribute('role', 'log');
  feed.setAttribute('aria-live', 'polite');

  const empty = el('div', 'bc-empty');
  empty.append(
    el('strong', null, 'Nothing is building.'),
    el('p', null, 'Describe a part on the Make tab and press Make it. Claude’s steps, comments and previews show up here as it works.')
  );

  const optionsRow = el('div', 'bc-options');
  optionsRow.hidden = true;

  const form = el('form', 'bc-compose');
  const input = el('textarea', 'bc-input');
  input.rows = 1;
  input.placeholder = 'Reply to Claude, answer its question, or ask for a change…';
  input.setAttribute('aria-label', 'Reply to Claude');
  const send = el('button', 'bc-send', 'Send');
  send.type = 'submit';
  form.append(input, send);
  const hint = el('div', 'bc-hint', 'Enter sends · Shift+Enter for a new line');

  panel.append(head, prog, feed, optionsRow, form, hint);
  root.append(panel, pill);
  (host || body).append(root);

  // ── rendering ─────────────────────────────────────────────────────────
  function atBottom() {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  }
  function scrollDown(force) {
    if (force || atBottom()) requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight));
  }

  function renderStep(n, item) {
    n.className = `bc-step is-${item.status || 'running'}`;
    n.textContent = '';
    const row = el('div', 'bc-step-row');
    const ic = el('span', 'bc-step-icon');
    ic.textContent = item.status === 'running' ? '' : item.status === 'error' ? '✕' : toolIcon(item.tool);
    if (item.status === 'running') ic.append(el('span', 'bc-spin'));
    const label = el('span', 'bc-step-label', item.text || item.tool || 'Step');
    row.append(ic, label);
    if (item.iteration) row.append(el('span', 'bc-iter', `#${item.iteration}`));
    if (item.summary) row.append(el('span', 'bc-step-summary', item.summary));
    n.append(row);
    if (Array.isArray(item.todos) && item.todos.length) {
      const ul = el('ul', 'bc-todos');
      for (const t of item.todos) {
        const li = el('li', `bc-todo is-${t.status}`);
        li.append(el('span', 'bc-todo-box', t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '›' : ''), el('span', null, t.text));
        ul.append(li);
      }
      n.append(ul);
    }
    const detail = [item.detail, item.result].filter(Boolean).join('\n\n');
    if (detail) {
      const d = el('details', 'bc-step-detail');
      d.append(el('summary', null, 'details'), el('pre', null, detail));
      n.append(d);
    }
  }

  function renderItem(item) {
    if (!item || !item.kind) return null;
    if (item.kind === 'step-done') {
      const target = item.ref && session && session.items.find((i) => i.id === item.ref);
      if (target) {
        target.status = item.ok ? 'done' : 'error';
        if (item.summary) target.summary = item.summary;
        if (item.detail) target.result = item.detail;
        const n = nodes.get(target.id);
        if (n) renderStep(n, target);
      }
      return null;
    }
    if (item.id && nodes.has(item.id)) return nodes.get(item.id);
    let n;
    switch (item.kind) {
      case 'user': {
        n = el('div', `bc-msg bc-user${item.brief ? ' is-brief' : ''}`);
        if (item.brief) n.append(el('div', 'bc-msg-label', 'Your request'));
        const b = el('div', 'bc-bubble');
        b.textContent = item.text || '';
        n.append(b);
        if (item.brief && (item.text || '').length > 260) {
          const more = el('button', 'bc-more', 'Show the full brief');
          more.type = 'button';
          more.addEventListener('click', () => {
            n.classList.toggle('is-open');
            more.textContent = n.classList.contains('is-open') ? 'Show less' : 'Show the full brief';
          });
          n.append(more);
        }
        break;
      }
      case 'assistant': {
        n = el('div', 'bc-msg bc-claude');
        const b = el('div', 'bc-bubble');
        b.append(renderMarkdown(item.text));
        if (item.question) {
          const q = el('div', 'bc-question');
          q.append(el('span', 'bc-question-tag', 'Question'), el('span', null, item.question));
          b.append(q);
        }
        n.append(b);
        break;
      }
      case 'step':
        n = el('div');
        renderStep(n, item);
        break;
      case 'image': {
        n = el('figure', 'bc-image');
        const img = el('img');
        img.alt = item.caption || 'Preview render';
        img.src = `data:${item.mime || 'image/png'};base64,${item.data}`;
        img.addEventListener('click', () => n.classList.toggle('is-big'));
        n.append(img);
        break;
      }
      case 'file': {
        n = el('div', 'bc-file');
        n.append(el('span', 'bc-file-icon', '◆'));
        const t = el('div', 'bc-file-text');
        t.append(el('strong', null, item.created ? 'New checkpoint' : 'Updated'), el('code', null, item.file));
        n.append(t);
        if (typeof onOpenFile === 'function') {
          const openBtn = el('button', 'bc-hbtn bc-file-open', 'Open');
          openBtn.type = 'button';
          openBtn.addEventListener('click', () => onOpenFile(item.file));
          n.append(openBtn);
        }
        break;
      }
      case 'error':
        n = el('div', 'bc-note is-error', item.text || 'Something went wrong.');
        break;
      default:
        n = el('div', 'bc-note', item.text || '');
    }
    if (item.id) nodes.set(item.id, n);
    feed.append(n);
    return n;
  }

  function lastOptions() {
    if (!session) return { options: [], question: null };
    for (let i = session.items.length - 1; i >= 0; i--) {
      const it = session.items[i];
      if (it.kind === 'user') return { options: [], question: null };
      if (it.kind === 'assistant') return { options: it.options || [], question: it.question || null };
    }
    return { options: [], question: null };
  }

  function renderOptions() {
    optionsRow.textContent = '';
    const { options } = lastOptions();
    if (running || !options.length) {
      optionsRow.hidden = true;
      return;
    }
    for (const opt of options) {
      const b = el('button', 'bc-option', opt);
      b.type = 'button';
      b.addEventListener('click', () => reply(opt));
      optionsRow.append(b);
    }
    optionsRow.hidden = false;
  }

  function stateName() {
    if (!session) return 'empty';
    if (running) return 'running';
    return session.status || 'idle';
  }

  function displayedPct() {
    if (!progress) return 0;
    const base = Number(progress.pct) || 0;
    if (!running || base >= 100) return base;
    // Creep inside a phase so a long step still moves, never past the next floor.
    const cap = Math.min(base + 18, 96);
    const t = (Date.now() - progressAt) / 1000;
    return base + (cap - base) * (1 - Math.exp(-t / 50));
  }

  function renderChrome() {
    const st = stateName();
    root.dataset.state = st;
    root.hidden = !enabled;
    const pct = displayedPct();
    progFill.style.width = `${pct.toFixed(1)}%`;
    pillFill.style.width = `${pct.toFixed(1)}%`;
    progTrack.setAttribute('aria-valuenow', String(Math.round(pct)));
    let label = progress && progress.label ? progress.label : st === 'empty' ? 'Idle' : '';
    // The result line arrives a moment before the process exits.
    if (running && progress && (progress.phase === 'done' || progress.phase === 'waiting')) label = 'Finishing up';
    progLabel.textContent = label;
    const bits = [];
    if (progress && progress.iteration) bits.push(`iteration ${progress.iteration}`);
    if (progress && progress.steps) bits.push(`${progress.steps} step${progress.steps === 1 ? '' : 's'}`);
    const started = (progress && progress.startedAt) || (session && session.turnStartedAt);
    if (started && (running || st === 'idle' || st === 'waiting')) {
      const endAt = running ? Date.now() : (session && session.updatedAt) || Date.now();
      bits.push(fmtElapsed(endAt - started));
    }
    progStats.textContent = bits.join(' · ');
    prog.hidden = st === 'empty';
    const statusText = {
      empty: '',
      running: 'working',
      idle: 'done',
      waiting: 'needs your answer',
      failed: 'stopped',
      cancelled: 'stopped',
    }[st];
    headStatus.textContent = statusText || '';
    stopBtn.hidden = !running;
    newBtn.hidden = running || !session;
    termBtn.disabled = running || !(session && session.sessionId);
    pillText.textContent = running
      ? `${label || 'Working'} · ${Math.round(pct)}%`
      : st === 'waiting'
        ? 'Claude asked you something'
        : st === 'failed' || st === 'cancelled'
          ? 'Build stopped'
          : st === 'idle'
            ? 'Build done — open the chat'
            : 'Claude';
    pillBadge.hidden = open || unread === 0;
    pillBadge.textContent = String(unread);
    input.disabled = running;
    send.disabled = running;
    input.placeholder = running
      ? 'Claude is working…'
      : st === 'waiting'
        ? 'Type your answer, or pick an option above…'
        : session
          ? 'Ask for a change, or pick an option above…'
          : 'Make something on the Make tab first…';
    if (!feed.contains(empty) && !session) feed.append(empty);
    if (session && feed.contains(empty)) empty.remove();
    renderOptions();
    body.classList.toggle('bc-open', open);
  }

  function setOpen(v) {
    open = Boolean(v);
    panel.hidden = !open;
    pill.setAttribute('aria-expanded', String(open));
    if (open) {
      unread = 0;
      scrollDown(true);
    }
    renderChrome();
  }

  function loadSession(s, isRunning) {
    session = s ? { ...s, items: Array.isArray(s.items) ? s.items.slice() : [] } : null;
    running = Boolean(isRunning);
    progress = (session && session.progress) || null;
    progressAt = Date.now();
    nodes.clear();
    feed.textContent = '';
    if (session) for (const it of session.items) renderItem(it);
    renderChrome();
    scrollDown(true);
  }

  // One fetch at a time: a burst of events from a new session shares it.
  let refreshing = null;
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const res = await api.makeSession();
        if (res && res.ok !== false) loadSession(res.session || null, res.running);
      } catch (err) {
        console.warn('[build-chat] could not load the session', err);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  // ── actions ───────────────────────────────────────────────────────────
  async function reply(text) {
    const t = String(text || '').trim();
    if (!t || running) return;
    input.value = '';
    autoGrow();
    const res = await api.makeReply(t).catch(() => null);
    if (!res || res.ok === false) {
      const reason = (res && (res.reason || res.error)) || 'the studio server did not answer';
      appendLocal({ kind: 'error', text: `Could not send that: ${reason}` });
      input.value = t;
    }
  }

  function appendLocal(item) {
    if (!session) session = { id: null, items: [], status: 'idle' };
    item.id = item.id || `local-${Date.now()}`;
    session.items.push(item);
    renderItem(item);
    renderChrome();
    scrollDown(true);
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    reply(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      reply(input.value);
    }
  });
  input.addEventListener('input', autoGrow);
  pill.addEventListener('click', () => setOpen(!open));
  minBtn.addEventListener('click', () => setOpen(false));
  stopBtn.addEventListener('click', async () => {
    stopBtn.disabled = true;
    try {
      await api.cancelMake();
    } finally {
      stopBtn.disabled = false;
    }
  });
  newBtn.addEventListener('click', async () => {
    const res = await api.makeNew().catch(() => null);
    if (res && res.ok) loadSession(null, false);
  });
  termBtn.addEventListener('click', () => {
    if (session && session.sessionId && typeof onContinueInTerminal === 'function') {
      onContinueInTerminal(session.sessionId);
    }
  });

  // ── live events ───────────────────────────────────────────────────────
  api.onMakeChat((msg) => {
    if (!msg || !msg.item) return;
    if (!session || (msg.session && session.id && msg.session !== session.id)) {
      // A different (newer) session started: fetch it whole so nothing is missed.
      refresh();
      return;
    }
    if (!session.id) session.id = msg.session;
    const item = msg.item;
    if (item.kind !== 'step-done') {
      if (item.id && session.items.some((i) => i.id === item.id)) return;
      session.items.push(item);
    }
    const stick = atBottom();
    renderItem(item);
    if (!open && item.kind !== 'step-done') unread += 1;
    renderChrome();
    if (stick) scrollDown(true);
  });

  api.onMakeProgress((p) => {
    if (!p) return;
    if (session && p.session && session.id && p.session !== session.id) return;
    const moved = !progress || progress.pct !== p.pct || progress.phase !== p.phase;
    progress = p;
    if (moved) progressAt = Date.now();
    if (session && p.sessionId) session.sessionId = p.sessionId;
    renderChrome();
  });

  api.onMakeEvent((evt) => {
    if (!evt) return;
    if (evt.event === 'start') {
      running = true;
      if (!evt.resume || !session || session.id !== evt.session) {
        // A fresh build: start from the server's copy, and open the panel.
        refresh().then(() => setOpen(true));
      } else {
        session.status = 'running';
        renderChrome();
      }
    } else if (evt.event === 'cleared') {
      loadSession(null, false);
    } else if (evt.event === 'done' || evt.event === 'error') {
      running = false;
      // Re-read once: it carries the session id and the final status.
      refresh().then(() => {
        if (!open) unread = Math.max(unread, 1);
        renderChrome();
      });
    }
  });

  const ticker = setInterval(() => {
    if (running) renderChrome();
  }, 1000);

  refresh();

  return {
    root,
    open: () => setOpen(true),
    close: () => setOpen(false),
    refresh,
    isRunning: () => running,
    /** The desktop hides the chat while the server serves another workspace. */
    setEnabled(v) {
      enabled = Boolean(v);
      if (!enabled) setOpen(false);
      renderChrome();
    },
    session: () => session,
    destroy() {
      clearInterval(ticker);
      root.remove();
    },
  };
}
