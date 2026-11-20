// renderer/studio-link.js — the desktop half of the v0.9 link to the Studio
// server (see main/studio-link.js for the why).
//
// What the desktop app gains from it:
//   - the live build chat, for builds started here OR in the web app;
//   - Make it runs on the server, so the web app (and a phone) can follow and
//     continue the same build — the desktop terminal can take the session
//     over at any point with "Open in terminal" (`claude --resume <id>`);
//   - the Customize view, the same code the web app runs.
//
// When the server is not running, nothing changes: Make it goes to the
// desktop terminal exactly as before, and Customize says what it needs.

import { createApiShim } from '../web/api-shim.js';
import { mountBuildChat } from './build-chat.js';
import { mountCustomize } from '../web/customize.js';

const PROBE_MS = 15000;

function norm(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function mountStudioLink(ctx) {
  const native = window.api;
  if (!native || typeof native.linkInfo !== 'function') return null;

  const state = { url: null, up: false, sameWorkspace: false, workspace: null, api: null };
  let chat = null;
  let customize = null;
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn(state));

  // ── the wrapped api the Studio uses ───────────────────────────────────
  // Every call goes to the desktop's own api, except Make it, which goes to
  // the server when the link is up and points at THIS workspace. A build in a
  // different workspace would write files this window never sees.
  const linked = () => state.up && state.sameWorkspace && state.api;
  const wrapped = Object.create(null);
  for (const k of Object.keys(native)) wrapped[k] = native[k];
  wrapped.composerSendToClaude = async (message) => {
    if (linked()) {
      const ok = await state.api.composerSendToClaude(message);
      return ok;
    }
    return native.composerSendToClaude(message);
  };
  Object.defineProperty(wrapped, 'lastSendFailure', {
    get: () => (linked() ? state.api.lastSendFailure : null),
    enumerable: true,
  });
  Object.defineProperty(wrapped, 'hasBuildChat', { get: () => Boolean(linked()), enumerable: true });
  ctx.api = wrapped;

  // ── probe ─────────────────────────────────────────────────────────────
  async function probe() {
    if (!state.api) return;
    const s = await state.api.makeStatus().catch(() => null);
    const wasUp = state.up;
    state.up = Boolean(s && typeof s === 'object' && 'running' in s);
    state.workspace = state.up ? s.workspace || null : null;
    const mine = ctx.workspaceDir || (await native.getWorkspace().catch(() => ''));
    // No reported workspace (an older server) is NOT a match: it could be any folder.
    state.sameWorkspace = Boolean(state.up && state.workspace && mine && norm(state.workspace) === norm(mine));
    document.body.classList.toggle('is-linked', Boolean(linked()));
    // Another workspace's chat and models would be misleading in this window.
    const foreign = state.up && !state.sameWorkspace;
    if (chat) chat.setEnabled(state.up ? !foreign : true);
    if (linked() && s.running) document.body.classList.add('is-making');
    if (state.up && !wasUp && chat) chat.refresh();
    notify();
  }

  native.linkInfo().then((info) => {
    if (!info || !info.url) return;
    state.url = info.url;
    const api = createApiShim({ base: info.url });
    api.download = (href) => native.linkDownload(href);
    state.api = api;
    api.connect();

    chat = mountBuildChat({
      api,
      onOpenFile: (file) => openFile(file),
      onContinueInTerminal: (sessionId) => {
        native.resumeSession(sessionId);
        if (ctx.studio && typeof ctx.studio.hide === 'function') ctx.studio.hide();
        if (ctx.showToast) ctx.showToast('Resumed that Claude session in the terminal — you have full control now.', 'success');
      },
    });

    // The Make it lock: the server refuses a second build, so say so up front.
    api.onMakeEvent((evt) => {
      if (!evt || !linked()) return;
      if (evt.event === 'start') document.body.classList.add('is-making');
      else if (evt.event === 'done' || evt.event === 'error') document.body.classList.remove('is-making');
      if (evt.event === 'done' && evt.file) {
        if (ctx.showToast) ctx.showToast(`Claude made ${evt.file}.`, 'success');
      }
    });

    // Hidden until the first probe says this is the same workspace.
    chat.setEnabled(false);
    probe();
    setInterval(probe, PROBE_MS);
    mountCustomizeTab(api);
  });

  async function openFile(file, tries = 0) {
    const list = await native.getCheckpoints().catch(() => null);
    const cps = (list && (list.checkpoints || list)) || {};
    const found = Object.entries(cps).find(([, c]) => c && c.file === file);
    if (found) {
      await native.selectCheckpoint(found[0]);
      if (ctx.studio && typeof ctx.studio.hide === 'function') ctx.studio.hide();
      return;
    }
    // The file watcher may not have picked it up yet.
    if (tries < 6) setTimeout(() => openFile(file, tries + 1), 700);
    else if (ctx.showToast) ctx.showToast(`${file} is not in this window's checkpoint list yet.`, 'error');
  }

  // ── the Customize tab ─────────────────────────────────────────────────
  function mountCustomizeTab(api) {
    const body = document.body;
    const switcher = (ctx.els && ctx.els.viewSwitch) || document.getElementById('view-switch');
    if (!switcher || document.getElementById('view-customize')) return;

    const tab = document.createElement('button');
    tab.id = 'view-customize';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-controls', 'customize');
    tab.textContent = 'Customize';
    // The tab joins the switch only once the link is live for THIS workspace,
    // and leaves it if the server turns out to serve another one. A window
    // with no server never shows it. Once shown, a server that stops
    // answering keeps the tab and says why instead.
    let everLinked = false;
    function placeTab(want) {
      if (want && !tab.isConnected) {
        const wb = document.getElementById('view-workbench');
        if (wb && wb.nextSibling) switcher.insertBefore(tab, wb.nextSibling);
        else switcher.appendChild(tab);
      } else if (!want && tab.isConnected) {
        if (body.dataset.view === 'customize' && ctx.studio) ctx.studio.show();
        tab.remove();
      }
    }

    const root = document.createElement('div');
    root.id = 'customize';
    root.hidden = true;
    const main = document.getElementById('main-content');
    if (main && main.parentNode) main.parentNode.insertBefore(root, main);
    else (document.getElementById('app') || body).appendChild(root);

    const offline = document.createElement('div');
    offline.className = 'cz-empty cz-offline';
    offline.hidden = true;

    function renderOffline() {
      const down = !state.up;
      offline.hidden = !down;
      offline.textContent = down
        ? `Customize runs on the ClawSCAD Studio server, and it is not answering at ${state.url}. ` +
          'Start the ClawSCAD-Studio-Web task (or run `node web/server.js`) and this view comes back on its own.'
        : '';
    }
    listeners.add(() => {
      if (linked()) everLinked = true;
      placeTab(everLinked && !(state.up && !state.sameWorkspace));
      renderOffline();
      if (state.up && !customize && !root.hidden) build();
    });

    function build() {
      if (customize || !state.up) return;
      try {
        const showToast = (m, k) => ctx.showToast && ctx.showToast(m, k);
        customize = mountCustomize(ctx, api, showToast);
        root.prepend(offline);
      } catch (err) {
        console.error('[link] mountCustomize threw', err);
      }
    }

    function show() {
      body.dataset.view = 'customize';
      root.hidden = false;
      if (!customize) {
        root.append(offline);
        build();
      }
      renderOffline();
      if (customize) customize.refresh(customize.getModel());
      sync();
    }
    function sync() {
      const on = body.dataset.view === 'customize';
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) for (const other of switcher.querySelectorAll('[role="tab"]')) if (other !== tab) other.setAttribute('aria-selected', 'false');
    }
    tab.addEventListener('click', show);
    new MutationObserver(() => {
      if (body.dataset.view !== 'customize' && !root.hidden) root.hidden = true;
      sync();
    }).observe(body, { attributes: true, attributeFilter: ['data-view'] });

    // A finished build opens in Customize when the user is already there.
    api.onMakeEvent((evt) => {
      if (evt && evt.event === 'done' && evt.file && customize && body.dataset.view === 'customize') customize.refresh(evt.file);
    });
  }

  return {
    state,
    onChange: (fn) => listeners.add(fn),
    chat: () => chat,
  };
}
