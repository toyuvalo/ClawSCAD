// renderer/finder.js — v0.8 "Find & Print". One search box over MakerWorld and
// Printables, a model page, and three actions: open it in ClawSCAD, print it on
// the P1S, or go to the source page.
//
// This one file runs in BOTH builds. The desktop app mounts it from renderer.js
// over window.api (preload.js -> main/model-finder.js); the web build mounts it
// from web/entry.js over the fetch shim (web/api-shim.js -> web/server.js). Both
// speak the same shapes: { ok, ... } or { ok:false, error:{ code, message } }.
//
// Rules this file keeps, each one a bug somewhere else:
//  - Nothing from a website is ever put in with innerHTML. Titles, authors and
//    descriptions are text nodes. Descriptions arrive already reduced to text.
//  - A disabled control is COLOURED and says why; opacity is never lowered.
//  - A site that fails never hides the other one: every site has its own status.
//  - Printing is never one click. Slice, look at the bed, tick "the bed is clear",
//    then start. The main process re-checks all of it; this is the front half.
//  - mountFinder never throws: a throw here would leave a tab that does nothing.

const SITE_LABEL = { makerworld: 'MakerWorld', printables: 'Printables', thingiverse: 'Thingiverse' };
const FALLBACK_SITES = [
  { id: 'makerworld', label: 'MakerWorld', available: true },
  { id: 'printables', label: 'Printables', available: true },
  { id: 'thingiverse', label: 'Thingiverse', available: false, reason: 'needs-token' },
];
const EXAMPLES = ['gridfinity', 'cable clip', 'phone stand', 'benchy'];
const STORE_KEY = 'clawscad.finder.v1';
const JOB_POLL_MS = 1000;
const PRINTER_POLL_MS = 15000;
const READY_STATES = ['IDLE', 'FINISH'];

const ICONS = {
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  heart: '<path d="M8 13.5S2.5 10 2.5 6.2A2.9 2.9 0 0 1 8 5a2.9 2.9 0 0 1 5.5 1.2C13.5 10 8 13.5 8 13.5z"/>',
  download: '<path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10"/>',
  back: '<path d="M10 3L5 8l5 5"/>',
  external: '<path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5"/>',
  printer: '<path d="M4.5 6V2.5h7V6M4.5 11.5h-2v-5h11v5h-2M4.5 9.5h7v4h-7z"/>',
  cube: '<path d="M8 2l5 2.5v7L8 14l-5-2.5v-7zM3 4.5L8 7l5-2.5M8 7v7"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  alert: '<path d="M8 2.5l6 10.5H2zM8 7v3M8 11.6v.1"/>',
};

export function mountFinder(ctx) {
  try {
    return mount(ctx);
  } catch (err) {
    console.error('[finder] mount failed', err);
    return null;
  }
}

function mount(ctx) {
  const api = (ctx && ctx.api) || null;
  if (!api || typeof api.finderSearch !== 'function') return null;

  const body = document.body;
  const switcher = (ctx.els && ctx.els.viewSwitch) || document.getElementById('view-switch');
  const toast = (msg, kind) => {
    try {
      if (ctx.showToast) ctx.showToast(msg, kind || 'info');
    } catch {
      /* a toast is a courtesy */
    }
  };

  // ── shell: tab + view root + stylesheet (created if the page lacks them) ──
  let root = document.getElementById('finder');
  if (!root) {
    root = document.createElement('div');
    root.id = 'finder';
    root.hidden = true;
    const anchor = document.getElementById('main-content');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(root, anchor);
    else (document.getElementById('app') || body).appendChild(root);
  }
  let tab = document.getElementById('view-finder');
  if (!tab && switcher) {
    tab = document.createElement('button');
    tab.id = 'view-finder';
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-controls', 'finder');
    tab.textContent = 'Find & Print';
    switcher.appendChild(tab);
  }
  // On a phone the header already holds three tabs; the fourth gets a short label
  // so the switch does not run off the screen. The accessible name stays whole.
  if (tab) {
    tab.setAttribute('aria-label', 'Find & Print');
    try {
      const narrow = window.matchMedia('(max-width: 520px)');
      const setLabel = () => {
        tab.textContent = narrow.matches ? 'Find' : 'Find & Print';
      };
      setLabel();
      if (narrow.addEventListener) narrow.addEventListener('change', setLabel);
    } catch {
      /* matchMedia missing: keep the long label */
    }
  }
  if (!document.getElementById('style-finder-link')) {
    const link = document.createElement('link');
    link.id = 'style-finder-link';
    link.rel = 'stylesheet';
    link.href = ctx.finderCssHref || './style-finder.css';
    document.head.appendChild(link);
  }

  // ── state ────────────────────────────────────────────────────────────
  const saved = loadSaved();
  let sites = FALLBACK_SITES.slice();
  let selected = new Set(saved.sites.length ? saved.sites : ['makerworld', 'printables']);
  let query = saved.query;
  let results = { query: '', page: 0, items: [], siteStatus: {}, loading: false, error: null, hasSearched: false };
  let searchSeq = 0;
  let view = 'search';
  let detail = null; // { item, data, loading, error, imageIndex, fileId, busy, note }
  let caps = { print: { available: false, reason: 'Checking...' } };
  let print = freshPrint();
  let printerTimer = null;

  function freshPrint() {
    return { open: false, status: null, statusError: null, mapping: null, slice: null, snapshot: null, confirmed: false, start: null, busy: '', message: '' };
  }

  // ── tiny DOM helpers (text only, never innerHTML for data) ────────────
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === false || v == null) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function icon(name, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'finder-icon' + (cls ? ' ' + cls : ''));
    // The path data is a constant from ICONS above, never site data.
    svg.innerHTML = ICONS[name] || '';
    return svg;
  }
  const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  const whole = new Intl.NumberFormat();
  const fmtCount = (n) => (Number.isFinite(n) ? compact.format(n) : null);
  const fmtDate = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d) : null;
  };
  const fmtBytes = (n) => {
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  };
  const fmtSeconds = (s) => {
    if (!Number.isFinite(s) || s <= 0) return null;
    const hrs = Math.floor(s / 3600);
    const min = Math.round((s % 3600) / 60);
    return hrs ? `${hrs} h ${min} min` : `${min} min`;
  };
  const errMsg = (r, fallback) => (r && r.error && r.error.message) || fallback;

  // ── static layout ─────────────────────────────────────────────────────
  root.textContent = '';
  const scroll = h('div', { class: 'finder-scroll', id: 'finder-scroll' });
  root.appendChild(scroll);

  const input = h('input', {
    id: 'finder-query',
    class: 'finder-input',
    type: 'search',
    placeholder: 'Search MakerWorld and Printables',
    'aria-label': 'Search for a model',
    autocomplete: 'off',
    enterkeyhint: 'search',
    maxlength: '200',
    spellcheck: 'false',
  });
  input.value = query;
  const goBtn = h('button', { class: 'finder-go', type: 'submit', id: 'finder-go' }, icon('search'), h('span', { text: 'Search' }));
  const form = h('form', { class: 'finder-search', id: 'finder-search', role: 'search' }, input, goBtn);
  const chipsEl = h('div', { class: 'finder-chips', id: 'finder-chips', role: 'group', 'aria-label': 'Sites to search' });
  const statusEl = h('div', { class: 'finder-status', id: 'finder-status', role: 'status', 'aria-live': 'polite' });
  const notesEl = h('div', { class: 'finder-notes', id: 'finder-notes' });
  const gridEl = h('div', { class: 'finder-grid', id: 'finder-results' });
  const introEl = h('section', { class: 'finder-intro', id: 'finder-intro' });
  const moreEl = h('div', { class: 'finder-more', id: 'finder-more' });
  const detailEl = h('section', { class: 'finder-detail', id: 'finder-detail', hidden: true });
  const searchView = h('div', { class: 'finder-searchview', id: 'finder-searchview' }, h('header', { class: 'finder-bar' }, form, chipsEl), statusEl, notesEl, introEl, gridEl, moreEl);
  scroll.append(searchView, detailEl);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(input.value, { reset: true });
  });

  // ── view switching (the tab) ──────────────────────────────────────────
  function showFinder() {
    body.dataset.view = 'finder';
    root.hidden = false;
    syncTab();
    if (tab && tab.scrollIntoView) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // a scrolling tab strip on 320 px phones
    if (!results.hasSearched && !input.value) setTimeout(() => input.focus(), 0);
  }
  function hideFinder() {
    root.hidden = true;
    stopPrinterPolling();
    syncTab();
  }
  function syncTab() {
    const on = body.dataset.view === 'finder';
    if (tab) tab.setAttribute('aria-selected', on ? 'true' : 'false');
    // Make / Customize / Workbench set their own tab to selected when they win,
    // but none of them knows this view exists, so they would stay lit beside it.
    if (on && switcher) {
      for (const other of switcher.querySelectorAll('[role="tab"]')) if (other !== tab) other.setAttribute('aria-selected', 'false');
    }
  }
  if (tab) tab.addEventListener('click', showFinder);
  // Another tab was chosen: studio.js / entry.js rewrite body[data-view]. Watching
  // the attribute keeps us correct without touching either of them.
  new MutationObserver(() => {
    if (body.dataset.view !== 'finder' && !root.hidden) hideFinder();
    else syncTab();
  }).observe(body, { attributes: true, attributeFilter: ['data-view'] });

  // ── external links ────────────────────────────────────────────────────
  function externalLink(url, label, cls) {
    const a = h('a', { class: cls || 'finder-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, label);
    a.addEventListener('click', (e) => {
      if (typeof api.finderOpenExternal === 'function') {
        e.preventDefault();
        api.finderOpenExternal(url).then((ok) => {
          if (!ok) toast('That link was not opened.', 'error');
        });
      }
    });
    return a;
  }

  // ── chips ─────────────────────────────────────────────────────────────
  function renderChips() {
    chipsEl.textContent = '';
    const usable = sites.filter((s) => s.available !== false).map((s) => s.id);
    const allOn = usable.every((id) => selected.has(id));
    const mk = (label, on, onClick, extra) =>
      h('button', { type: 'button', class: 'finder-chip' + (on ? ' is-on' : ''), 'aria-pressed': on ? 'true' : 'false', onClick, ...extra }, label);
    chipsEl.appendChild(
      mk('All sites', allOn, () => {
        selected = new Set(usable);
        chipsChanged();
      }, { 'data-site': 'all' })
    );
    for (const s of sites) {
      if (s.available === false) {
        chipsEl.appendChild(
          h(
            'button',
            { type: 'button', class: 'finder-chip is-unavailable', disabled: true, 'data-site': s.id, title: reasonText(s.reason, s.label) },
            s.label,
            h('span', { class: 'finder-chip-why', text: reasonShort(s.reason) })
          )
        );
        continue;
      }
      chipsEl.appendChild(
        mk(s.label, selected.has(s.id), () => {
          if (selected.has(s.id) && selected.size === 1) return; // never zero sites
          if (selected.has(s.id)) selected.delete(s.id);
          else selected.add(s.id);
          chipsChanged();
        }, { 'data-site': s.id })
      );
    }
  }
  function reasonShort(reason) {
    return reason === 'needs-token' ? 'needs token' : 'unavailable';
  }
  function reasonText(reason, label) {
    return reason === 'needs-token' ? `${label} needs an API token that this app does not have yet.` : `${label} is not available.`;
  }
  function chipsChanged() {
    persist();
    renderChips();
    if (results.hasSearched && input.value.trim()) runSearch(input.value, { reset: true });
  }

  // ── search ────────────────────────────────────────────────────────────
  async function runSearch(text, { reset = false } = {}) {
    const q = String(text || '').trim();
    if (!q) {
      input.focus();
      return;
    }
    const seq = ++searchSeq;
    query = q;
    persist();
    const page = reset ? 0 : results.page + 1;
    results.loading = true;
    results.hasSearched = true;
    if (reset) {
      results.items = [];
      results.siteStatus = {};
    }
    results.error = null;
    renderResults();
    const out = await api.finderSearch({ query: q, sites: [...selected], page, limit: 24 });
    if (seq !== searchSeq) return; // a newer search owns the screen
    results.loading = false;
    if (!out || !out.ok) {
      results.error = errMsg(out, 'The search failed.');
    } else {
      results.query = out.query;
      results.page = out.page;
      const known = new Set(results.items.map((i) => i.id));
      results.items = results.items.concat(out.items.filter((i) => !known.has(i.id)));
      results.siteStatus = out.sites || {};
      results.lastBatch = out.items.length;
    }
    renderResults();
  }

  function renderResults() {
    const hasItems = results.items.length > 0;
    introEl.hidden = results.hasSearched;
    gridEl.textContent = '';
    notesEl.textContent = '';
    moreEl.textContent = '';

    if (!results.hasSearched) {
      renderIntro();
      statusEl.textContent = '';
      return;
    }

    if (results.loading && !hasItems) {
      for (let i = 0; i < 12; i++) gridEl.appendChild(skeletonCard());
      statusEl.textContent = `Searching for "${query}"...`;
      return;
    }

    for (const item of results.items) gridEl.appendChild(card(item));

    if (results.error) {
      notesEl.appendChild(note('error', results.error, () => runSearch(query, { reset: true })));
    }
    for (const [site, st] of Object.entries(results.siteStatus)) {
      const label = SITE_LABEL[site] || site;
      if (st.status === 'error') {
        notesEl.appendChild(note('error', `${label} did not answer. ${(st.error && st.error.message) || ''}`.trim(), () => runSearch(query, { reset: true }), 'Try again'));
      } else if (st.status === 'stale') {
        notesEl.appendChild(note('warn', `${label} is not answering, so these results are ${ageText(st.ageMs)} old.`, () => runSearch(query, { reset: true }), 'Try again'));
      } else if (st.status === 'unavailable') {
        notesEl.appendChild(note('info', `${label}: ${(st.error && st.error.message) || 'not available.'}`));
      }
    }

    if (!hasItems && !results.loading) {
      statusEl.textContent = '';
      const anySiteError = Object.values(results.siteStatus).some((s) => s.status === 'error');
      gridEl.appendChild(
        h(
          'div',
          { class: 'finder-empty', id: 'finder-empty' },
          h('strong', { text: anySiteError ? `No results to show for "${query}".` : `Nothing found for "${query}".` }),
          h('span', { text: anySiteError ? 'Every site you picked failed or has no match. Check the notes above, or try again.' : 'Try fewer words, or search another site.' })
        )
      );
      return;
    }

    const counts = Object.entries(results.siteStatus)
      .filter(([, s]) => s.status === 'ok' || s.status === 'stale')
      .map(([site, s]) => `${SITE_LABEL[site] || site} ${s.total != null ? whole.format(s.total) : s.count}`);
    statusEl.textContent = `${whole.format(results.items.length)} shown for "${query}"${counts.length ? ' (' + counts.join(', ') + ' found)' : ''}`;

    const canMore = results.lastBatch > 0 && Object.values(results.siteStatus).some((s) => s.status === 'ok');
    if (canMore) {
      moreEl.appendChild(
        h('button', { type: 'button', class: 'finder-btn finder-btn-secondary', id: 'finder-more-btn', disabled: results.loading, onClick: () => runSearch(query) }, results.loading ? 'Loading...' : 'Show more')
      );
    }
  }

  function ageText(ms) {
    const m = Math.round((ms || 0) / 60000);
    if (m < 90) return `${m} min`;
    const hrs = Math.round(m / 60);
    return hrs < 48 ? `${hrs} h` : `${Math.round(hrs / 24)} days`;
  }

  function note(kind, text, onRetry, retryLabel) {
    return h(
      'div',
      { class: `finder-note is-${kind}`, role: kind === 'error' ? 'alert' : null },
      icon(kind === 'info' ? 'check' : 'alert'),
      h('span', { class: 'finder-note-text', text }),
      onRetry ? h('button', { type: 'button', class: 'finder-btn finder-btn-small', onClick: onRetry }, retryLabel || 'Try again') : null
    );
  }

  function renderIntro() {
    introEl.textContent = '';
    introEl.append(
      h('h1', { class: 'finder-intro-title', text: 'Find a model to print' }),
      h('p', { class: 'finder-intro-sub', text: 'Search MakerWorld and Printables from one box. Open any model in ClawSCAD to change it, or print it on your P1S.' }),
      h(
        'div',
        { class: 'finder-examples', role: 'group', 'aria-label': 'Example searches' },
        h('span', { class: 'finder-examples-label', text: 'Try' }),
        EXAMPLES.map((ex) =>
          h('button', { type: 'button', class: 'finder-chip', onClick: () => { input.value = ex; runSearch(ex, { reset: true }); } }, ex)
        )
      )
    );
  }

  function skeletonCard() {
    return h('div', { class: 'finder-card is-skeleton', 'aria-hidden': 'true' }, h('div', { class: 'finder-card-cover' }), h('div', { class: 'finder-card-body' }, h('div', { class: 'finder-skel-line' }), h('div', { class: 'finder-skel-line is-short' })));
  }

  function badge(site) {
    return h('span', { class: 'finder-badge', 'data-site': site, text: SITE_LABEL[site] || site });
  }

  function cover(url) {
    const wrap = h('div', { class: 'finder-card-cover' });
    if (url) {
      const img = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => {
        img.remove();
        wrap.classList.add('is-broken');
        wrap.appendChild(h('span', { class: 'finder-nopic', text: 'No picture' }));
      });
      wrap.appendChild(img);
    } else {
      wrap.classList.add('is-broken');
      wrap.appendChild(h('span', { class: 'finder-nopic', text: 'No picture' }));
    }
    return wrap;
  }

  function stats(item) {
    const bits = [];
    const likes = fmtCount(item.likes);
    const dls = fmtCount(item.downloads);
    if (likes) bits.push(h('span', { class: 'finder-stat', title: `${whole.format(item.likes)} likes` }, icon('heart'), likes));
    if (dls) bits.push(h('span', { class: 'finder-stat', title: `${whole.format(item.downloads)} downloads` }, icon('download'), dls));
    return bits;
  }

  function card(item) {
    const c = cover(item.cover);
    c.appendChild(badge(item.site));
    const el = h(
      'button',
      {
        type: 'button',
        class: 'finder-card',
        'data-id': item.id,
        'data-site': item.site,
        'aria-label': `${item.title}${item.author ? ', by ' + item.author : ''}, ${SITE_LABEL[item.site] || item.site}`,
        onClick: () => openDetail(item),
      },
      c,
      h(
        'div',
        { class: 'finder-card-body' },
        h('h3', { class: 'finder-card-title', title: item.title, text: item.title }),
        h('div', { class: 'finder-card-author', text: item.author ? `by ${item.author}` : 'Author not shown' }),
        h('div', { class: 'finder-card-meta' }, stats(item), item.licence ? h('span', { class: 'finder-licence', title: item.licenceName || item.licence, text: item.licence }) : null)
      )
    );
    return el;
  }

  // ── detail ────────────────────────────────────────────────────────────
  async function openDetail(item) {
    resetPrint();
    detail = { item, data: null, loading: true, error: null, imageIndex: 0, fileId: null, busy: '', note: null };
    view = 'detail';
    renderDetail();
    scroll.scrollTop = 0;
    const back = document.getElementById('finder-back');
    if (back) back.focus({ preventScroll: true }); // the clicked card just left the screen
    await loadDetail();
  }

  async function loadDetail() {
    const d = detail;
    if (!d) return;
    d.loading = true;
    d.error = null;
    renderDetail();
    const out = await api.finderDetail({ site: d.item.site, id: d.item.siteId });
    if (detail !== d) return;
    d.loading = false;
    if (!out || !out.ok) d.error = errMsg(out, 'The model page could not be loaded.');
    else {
      d.data = out.detail;
      const first = (out.detail.files || []).find((f) => f.printable && f.downloadable);
      d.fileId = first ? first.id : null;
      d.stale = Boolean(out.stale);
    }
    renderDetail();
  }

  function closeDetail() {
    stopPrinterPolling();
    detail = null;
    view = 'search';
    resetPrint();
    renderDetail();
    // Put focus back on the card that was open.
    setTimeout(() => {
      const last = scroll.querySelector('.finder-card[data-last="1"]');
      if (last) last.focus();
    }, 0);
  }

  // On the document, not on the root: after a card is clicked the card is gone and
  // focus sits on <body>, so a listener on the root would never hear Escape.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || view !== 'detail' || root.hidden || body.dataset.view !== 'finder' || e.defaultPrevented) return;
    if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
    closeDetail();
  });

  function renderDetail() {
    // The detail view is rebuilt on every state change, so keyboard focus would
    // be lost with the old buttons. Remember which control had it and give it
    // back to its twin in the new tree.
    const active = document.activeElement;
    let focusKey = null;
    if (active && detailEl.contains(active)) focusKey = active.id ? `#${active.id}` : active.getAttribute('data-focus') ? `[data-focus="${active.getAttribute('data-focus')}"]` : null;
    renderDetailTree();
    if (focusKey) {
      const again = detailEl.querySelector(focusKey);
      if (again && again !== document.activeElement) again.focus({ preventScroll: true });
    }
  }

  function renderDetailTree() {
    searchView.hidden = view === 'detail';
    detailEl.hidden = view !== 'detail';
    detailEl.textContent = '';
    if (view !== 'detail' || !detail) return;
    const { item, data } = detail;
    const src = data || item;

    detailEl.appendChild(
      h('button', { type: 'button', class: 'finder-back', id: 'finder-back', onClick: closeDetail }, icon('back'), h('span', { text: 'Back to results' }))
    );

    const images = (data && data.images && data.images.length ? data.images : item.cover ? [item.cover] : []).slice(0, 24);
    const idx = Math.min(detail.imageIndex, Math.max(0, images.length - 1));
    const gallery = h('div', { class: 'finder-gallery', id: 'finder-gallery' });
    const main = cover(images[idx] || null);
    main.classList.add('is-main');
    gallery.appendChild(main);
    if (images.length > 1) {
      const thumbs = h('div', { class: 'finder-thumbs', role: 'group', 'aria-label': 'Pictures' });
      images.forEach((url, i) => {
        const t = h('button', { type: 'button', 'data-focus': `thumb-${i}`, class: 'finder-thumb' + (i === idx ? ' is-on' : ''), 'aria-label': `Picture ${i + 1} of ${images.length}`, 'aria-pressed': i === idx ? 'true' : 'false', onClick: () => { detail.imageIndex = i; renderDetail(); } });
        t.appendChild(h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }));
        thumbs.appendChild(t);
      });
      gallery.appendChild(thumbs);
    }

    const info = h('div', { class: 'finder-info' });
    info.append(
      h('div', { class: 'finder-info-top' }, badge(item.site), data && data.category ? h('span', { class: 'finder-category', text: data.category }) : null),
      h('h2', { class: 'finder-title', id: 'finder-title', text: src.title }),
      h(
        'div',
        { class: 'finder-byline' },
        src.author ? h('span', { text: 'by ' }) : null,
        src.author ? (src.authorUrl ? externalLink(src.authorUrl, src.author, 'finder-link') : h('span', { text: src.author })) : null,
        data && fmtDate(data.published) ? h('span', { class: 'finder-dim', text: ` · ${fmtDate(data.published)}` }) : null
      ),
      h(
        'div',
        { class: 'finder-stats' },
        stats(src),
        Number.isFinite(src.prints) && src.prints > 0 ? h('span', { class: 'finder-stat', title: `${whole.format(src.prints)} prints` }, icon('printer'), compact.format(src.prints)) : null
      ),
      licenceBlock(src, data)
    );

    info.appendChild(actionsBlock());
    if (detail.note) info.appendChild(detail.note.nodeType ? detail.note : h('p', { class: 'finder-actionnote', role: 'status', text: String(detail.note) }));

    const top = h('div', { class: 'finder-detail-top' }, gallery, info);
    detailEl.appendChild(top);

    if (detail.loading) {
      detailEl.appendChild(h('div', { class: 'finder-loading', role: 'status', text: 'Loading the model page...' }));
    }
    if (detail.error) {
      detailEl.appendChild(note('error', detail.error, loadDetail, 'Try again'));
    }
    if (data) {
      if (detail.stale) detailEl.appendChild(note('warn', `${SITE_LABEL[item.site]} is not answering, so this page comes from the saved copy.`));
      if (print.open) detailEl.appendChild(printPanel());
      detailEl.appendChild(filesBlock(data));
      if (data.plates && data.plates.length) detailEl.appendChild(platesBlock(data));
      detailEl.appendChild(aboutBlock(data));
    }
    const lastCard = gridEl.querySelector(`.finder-card[data-id="${cssEsc(item.id)}"]`);
    gridEl.querySelectorAll('.finder-card[data-last]').forEach((n) => n.removeAttribute('data-last'));
    if (lastCard) lastCard.setAttribute('data-last', '1');
  }

  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));

  function licenceBlock(src, data) {
    const wrap = h('div', { class: 'finder-licenceblock', id: 'finder-licence' });
    const label = src.licence || src.licenceName;
    wrap.appendChild(h('span', { class: 'finder-licence is-big', title: src.licenceName || '', text: label || 'Licence not stated' }));
    const info = data && data.licenceInfo;
    const lines = [];
    if (info) {
      if (info.remix === 'no') lines.push('Print it for yourself. Do not share remixes or re-host the files.');
      else if (info.remix === 'yes') lines.push('You may remix it and share the result with credit.');
      if (info.commercial === 'no') lines.push('Not for selling or commercial use.');
    }
    if (!label) lines.push('Check the model page before you share anything made from it.');
    if (lines.length) wrap.appendChild(h('p', { class: 'finder-licence-note', text: lines.join(' ') }));
    if (info && info.url) wrap.appendChild(externalLink(info.url, 'Read the licence', 'finder-link finder-licence-link'));
    return wrap;
  }

  function selectedFile() {
    return detail && detail.data ? (detail.data.files || []).find((f) => f.id === detail.fileId) || null : null;
  }

  function actionsBlock() {
    const d = detail;
    const data = d.data;
    const file = selectedFile();
    const wrap = h('div', { class: 'finder-actions', id: 'finder-actions' });
    const isMw = d.item.site === 'makerworld';
    const dlReason =
      data && data.download && !data.download.available
        ? data.download.reason === 'needs-login'
          ? 'Needs Bambu login. MakerWorld gives files only to a signed-in Bambu account, and this app has no login yet. Use "Open on MakerWorld".'
          : data.download.message
        : null;

    // Open in ClawSCAD
    const openReason = !data ? 'Loading the file list...' : isMw ? dlReason : !file ? 'Pick an STL or 3MF file below.' : null;
    const openBtn = h('button', { type: 'button', class: 'finder-btn finder-btn-secondary', id: 'finder-open-btn', disabled: Boolean(openReason || d.busy), onClick: openInClawscad }, icon('cube'), h('span', { text: d.busy === 'open' ? 'Opening...' : 'Open in ClawSCAD' }));
    // Print
    const printReason = !data
      ? 'Loading the file list...'
      : isMw
        ? dlReason
        : !caps.print.available
          ? caps.print.reason
          : !file
            ? 'Pick an STL or 3MF file below.'
            : null;
    const printBtn = h('button', { type: 'button', class: 'finder-btn finder-btn-primary', id: 'finder-print-btn', disabled: Boolean(printReason || d.busy), 'aria-expanded': print.open ? 'true' : 'false', onClick: togglePrint }, icon('printer'), h('span', { text: 'Print on P1S' }));
    wrap.append(h('div', { class: 'finder-actionrow' }, printBtn, openBtn, externalLink(d.item.url, [h('span', { text: `Open on ${SITE_LABEL[d.item.site] || d.item.site}` }), icon('external')], 'finder-btn finder-btn-ghost')));
    const reasons = [];
    if (printReason && printReason === openReason) {
      reasons.push(h('p', { class: 'finder-why', id: 'finder-print-why', text: printReason }));
    } else {
      if (printReason) reasons.push(h('p', { class: 'finder-why', id: 'finder-print-why', text: `Print: ${printReason}` }));
      if (openReason) reasons.push(h('p', { class: 'finder-why', id: 'finder-open-why', text: `Open in ClawSCAD: ${openReason}` }));
    }
    wrap.append(...reasons);
    return wrap;
  }

  function filesBlock(data) {
    // Files this app can use come first; the rest stay listed so nothing is hidden.
    const all = data.files || [];
    const files = all.filter((f) => f.printable && f.downloadable).concat(all.filter((f) => !(f.printable && f.downloadable)));
    const sec = h('section', { class: 'finder-section', id: 'finder-files' }, h('h3', { class: 'finder-h3', text: `Files${files.length ? ' (' + files.length + ')' : ''}` }));
    const locked = files.filter((f) => !(f.printable && f.downloadable));
    if (locked.length && locked.length === files.length && data.download && data.download.message) {
      sec.appendChild(h('p', { class: 'finder-dim', id: 'finder-files-why', text: data.download.message }));
    } else if (locked.length) {
      sec.appendChild(h('p', { class: 'finder-dim', id: 'finder-files-why', text: 'Only STL and 3MF files can be downloaded here. The other files are listed so you can find them on the model page.' }));
    }
    if (!files.length) {
      sec.appendChild(h('p', { class: 'finder-dim', text: 'The site lists no files for this model.' }));
      return sec;
    }
    const list = h('ul', { class: 'finder-filelist', role: 'radiogroup', 'aria-label': 'Choose a file' });
    for (const f of files) {
      const usable = f.printable && f.downloadable;
      const on = f.id === detail.fileId;
      const row = h(
        'li',
        { class: 'finder-file' + (on ? ' is-on' : '') + (usable ? '' : ' is-locked'), 'data-file-id': f.id },
        h(
          'button',
          {
            type: 'button',
            'data-focus': `file-${f.id}`,
            class: 'finder-file-btn',
            role: 'radio',
            'aria-checked': on ? 'true' : 'false',
            'aria-disabled': usable ? null : 'true',
            title: usable ? f.name : f.reason || '',
            onClick: () => {
              if (!usable) return;
              detail.fileId = f.id;
              resetPrintResults();
              renderDetail();
            },
          },
          h('span', { class: 'finder-file-kind', text: (f.kind || 'file').toUpperCase() }),
          h('span', { class: 'finder-file-main' }, h('span', { class: 'finder-file-name', text: f.name }), f.folder ? h('span', { class: 'finder-file-note', text: f.folder }) : null, f.note ? h('span', { class: 'finder-file-note', text: f.note }) : null, usable ? null : h('span', { class: 'finder-file-why', text: f.reasonShort || 'Not downloadable here' })),
          h('span', { class: 'finder-file-size', text: fmtBytes(f.size) || '' })
        )
      );
      list.appendChild(row);
    }
    sec.appendChild(list);
    return sec;
  }

  function platesBlock(data) {
    const sec = h('section', { class: 'finder-section', id: 'finder-plates' }, h('h3', { class: 'finder-h3', text: 'Print profiles from the author' }), h('p', { class: 'finder-dim', text: 'For reference. The files need a Bambu login to download.' }));
    const grid = h('div', { class: 'finder-plategrid' });
    for (const p of data.plates.slice(0, 12)) {
      const t = fmtSeconds(p.seconds);
      grid.appendChild(
        h(
          'div',
          { class: 'finder-plate' },
          p.thumbnail ? h('img', { src: p.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div', { class: 'finder-plate-blank' }),
          h('div', { class: 'finder-plate-text' }, h('strong', { text: `Plate ${p.index || ''}`.trim() }), h('span', { text: [p.printer, t, p.grams != null ? `${p.grams} g` : null].filter(Boolean).join(' · ') }), h('span', { class: 'finder-dim', text: (p.filaments || []).map((f) => f.type).filter(Boolean).join(' + ') }))
        )
      );
    }
    sec.appendChild(grid);
    return sec;
  }

  function aboutBlock(data) {
    const sec = h('section', { class: 'finder-section', id: 'finder-about' }, h('h3', { class: 'finder-h3', text: 'About this model' }));
    const paras = String(data.description || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (!paras.length) sec.appendChild(h('p', { class: 'finder-dim', text: 'The author wrote no description.' }));
    const prose = h('div', { class: 'finder-prose' });
    for (const p of paras.slice(0, 40)) prose.appendChild(h('p', { text: p }));
    sec.appendChild(prose);
    if (data.tags && data.tags.length) {
      sec.appendChild(h('div', { class: 'finder-tags' }, data.tags.slice(0, 16).map((t) => h('span', { class: 'finder-tag', text: t }))));
    }
    return sec;
  }

  // ── actions: download + open in ClawSCAD ───────────────────────────────
  async function ensureDownloaded() {
    const d = detail;
    const file = selectedFile();
    if (!file) throw new Error('Pick an STL or 3MF file first.');
    const out = await api.finderDownload({ site: d.item.site, id: d.item.siteId, fileId: file.id });
    if (!out || !out.ok) throw new Error(errMsg(out, 'The download failed.'));
    return out;
  }

  async function openInClawscad() {
    const d = detail;
    if (!d || d.busy) return;
    d.busy = 'open';
    d.note = 'Downloading the file...';
    renderDetail();
    try {
      const dl = await ensureDownloaded();
      d.note = 'Making a checkpoint...';
      renderDetail();
      const out = await api.finderOpen({ site: d.item.site, id: d.item.siteId, path: dl.path });
      if (!out || !out.ok) throw new Error(errMsg(out, 'The checkpoint could not be made.'));
      if (typeof api.selectCheckpoint === 'function' && !out.checkpointId) {
        try {
          await api.selectCheckpoint(null, out.scad);
        } catch {
          /* the Workbench lists it anyway */
        }
      }
      d.note = h(
        'p',
        { class: 'finder-actionnote is-ok', id: 'finder-open-done', role: 'status' },
        icon('check'),
        h('span', { text: `Opened as ${out.scad}${out.warning ? '. ' + out.warning : '.'} ` }),
        h('button', { type: 'button', class: 'finder-linkbtn', id: 'finder-show-workbench', onClick: showWorkbench }, 'Show in Workbench')
      );
      toast(`Opened ${out.scad} as a new checkpoint.`, 'success');
    } catch (err) {
      d.note = h('p', { class: 'finder-actionnote is-error', role: 'alert' }, icon('alert'), h('span', { text: String((err && err.message) || err) }));
    } finally {
      d.busy = '';
      if (detail === d) renderDetail();
    }
  }

  function showWorkbench() {
    const wb = document.getElementById('view-workbench');
    if (wb) wb.click();
  }

  // ── print ─────────────────────────────────────────────────────────────
  function resetPrintResults() {
    print.slice = null;
    print.snapshot = null;
    print.confirmed = false;
    print.start = null;
    print.message = '';
  }
  function resetPrint() {
    stopPrinterPolling();
    print = freshPrint();
  }

  function togglePrint() {
    print.open = !print.open;
    if (print.open) {
      refreshPrinter(true);
      startPrinterPolling();
    } else {
      stopPrinterPolling();
    }
    renderDetail();
    if (print.open) {
      const p = document.getElementById('finder-print');
      if (p && p.scrollIntoView) p.scrollIntoView({ block: 'nearest' });
    }
  }

  async function refreshPrinter(fresh) {
    const out = await api.finderPrinterStatus({ fresh: Boolean(fresh) });
    if (!print.open) return;
    if (!out || !out.ok) {
      print.status = null;
      print.statusError = errMsg(out, 'The printer did not answer.');
    } else {
      print.status = out;
      print.statusError = null;
      if (print.mapping == null) {
        const firstOk = (out.trays || []).find((t) => !t.empty && ['PLA', 'PETG', 'PETG-CF'].includes(String(t.type).toUpperCase()));
        if (firstOk) print.mapping = firstOk.mapping;
      }
    }
    if (detail && print.open) renderDetail();
  }

  function startPrinterPolling() {
    stopPrinterPolling();
    printerTimer = setInterval(() => {
      if (document.hidden || body.dataset.view !== 'finder' || !print.open) return;
      if (print.busy === 'slice') return; // do not queue a printer call behind a slice
      refreshPrinter(true);
    }, PRINTER_POLL_MS);
  }
  function stopPrinterPolling() {
    if (printerTimer) clearInterval(printerTimer);
    printerTimer = null;
  }

  async function waitJob(jobId, onStage) {
    for (;;) {
      const out = await api.finderJob(jobId);
      if (!out || !out.ok) throw new Error(errMsg(out, 'Lost track of the job.'));
      if (onStage) onStage(out.job);
      if (out.job.status !== 'running') return out.job;
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    }
  }

  async function doSlice() {
    const d = detail;
    if (!d || print.busy) return;
    print.busy = 'slice';
    print.message = 'Downloading the file...';
    print.sliceError = null;
    print.startError = null;
    print.slice = null;
    print.snapshot = null;
    print.confirmed = false;
    print.start = null;
    renderDetail();
    try {
      const dl = await ensureDownloaded();
      const prep = await api.finderPrintPrepare({ site: d.item.site, id: d.item.siteId, path: dl.path, mapping: print.mapping });
      if (!prep || !prep.ok) throw new Error(errMsg(prep, 'Slicing could not start.'));
      const job = await waitJob(prep.jobId, (j) => {
        print.message = j.stage || 'Slicing...';
        if (detail === d) renderPrintMessageOnly();
      });
      if (job.status !== 'done') throw new Error((job.error && job.error.message) || 'Slicing failed.');
      print.slice = { ...job.result, jobId: prep.jobId };
      print.message = '';
    } catch (err) {
      print.message = '';
      print.sliceError = String((err && err.message) || err);
    } finally {
      print.busy = '';
      if (detail === d) renderDetail();
    }
  }

  function renderPrintMessageOnly() {
    const el = document.getElementById('finder-print-progress');
    if (el) el.textContent = print.message;
  }

  async function doSnapshot() {
    if (print.busy) return;
    print.busy = 'snapshot';
    print.snapshotError = null;
    renderDetail();
    const out = await api.finderPrinterSnapshot();
    print.busy = '';
    if (!out || !out.ok) {
      print.snapshot = null;
      print.snapshotError = errMsg(out, 'The camera did not answer.');
    } else {
      print.snapshot = out;
      print.confirmed = false;
    }
    renderDetail();
  }

  async function doStart() {
    const d = detail;
    if (!d || print.busy || !print.slice || !print.snapshot || !print.confirmed) return;
    print.busy = 'start';
    print.startError = null;
    renderDetail();
    try {
      const out = await api.finderPrintStart({ prepareJobId: print.slice.jobId, bedClear: true, snapshotToken: print.snapshot.token });
      if (!out || !out.ok) throw new Error(errMsg(out, 'The print could not start.'));
      const job = await waitJob(out.jobId, (j) => {
        print.message = j.stage || 'Starting...';
        if (detail === d) renderPrintMessageOnly();
      });
      if (job.status !== 'done') throw new Error((job.error && job.error.message) || 'The printer did not start.');
      print.start = { at: Date.now() };
      print.snapshot = null; // single use
      print.confirmed = false;
      toast('The print has started.', 'success');
      refreshPrinter(true);
    } catch (err) {
      print.startError = String((err && err.message) || err);
    } finally {
      print.busy = '';
      print.message = '';
      if (detail === d) renderDetail();
    }
  }

  /** "PLA Matte", not "PLA PLA Matte": the brand string usually already starts with the type. */
  function trayLabel(t) {
    const type = String(t.type || '');
    const brand = String(t.brand || '');
    if (!brand) return type;
    return brand.toUpperCase().includes(type.toUpperCase()) ? brand : `${type} ${brand}`.trim();
  }

  function printPanel() {
    const sec = h('section', { class: 'finder-section finder-print', id: 'finder-print', 'aria-labelledby': 'finder-print-h' });
    sec.appendChild(h('h3', { class: 'finder-h3', id: 'finder-print-h', text: 'Print on the P1S' }));
    const file = selectedFile();
    sec.appendChild(h('p', { class: 'finder-dim', text: file ? `File: ${file.name}` : 'No file picked.' }));

    // 1. printer + filament slot
    const st = print.status;
    const step1 = h('div', { class: 'finder-step', id: 'finder-step-slot' }, h('h4', { class: 'finder-h4', text: '1. Filament slot' }));
    if (print.statusError) step1.appendChild(note('error', print.statusError, () => refreshPrinter(true), 'Try again'));
    else if (!st) step1.appendChild(h('p', { class: 'finder-dim', role: 'status', text: 'Asking the printer...' }));
    else {
      const busy = !READY_STATES.includes(st.state);
      step1.appendChild(
        h(
          'p',
          { class: 'finder-printer-line', id: 'finder-printer-line' },
          h('span', { class: 'finder-state' + (busy ? ' is-busy' : ' is-ready'), id: 'finder-printer-state', text: st.state || 'UNKNOWN' }),
          busy ? h('span', { text: ` ${st.percent != null ? st.percent + '%' : ''}${st.remainingMin ? ', ' + st.remainingMin + ' min left' : ''}. You can slice now. Printing needs IDLE or FINISH.` }) : h('span', { text: ' Ready for a new print.' }),
          h('button', { type: 'button', class: 'finder-linkbtn', onClick: () => refreshPrinter(true) }, 'Refresh')
        )
      );
      const trays = h('div', { class: 'finder-trays', role: 'radiogroup', 'aria-label': 'AMS slot' });
      for (const t of st.trays || []) {
        const supported = !t.empty && ['PLA', 'PETG', 'PETG-CF'].includes(String(t.type).toUpperCase());
        const on = print.mapping === t.mapping;
        trays.appendChild(
          h(
            'button',
            {
              type: 'button',
              'data-focus': `tray-${t.mapping}`,
              class: 'finder-tray' + (on ? ' is-on' : '') + (supported ? '' : ' is-locked'),
              role: 'radio',
              'aria-checked': on ? 'true' : 'false',
              'aria-disabled': supported ? null : 'true',
              'data-slot': t.slot,
              onClick: () => {
                if (!supported) return;
                print.mapping = t.mapping;
                resetPrintResults();
                renderDetail();
              },
            },
            h('span', { class: 'finder-swatch', style: t.color ? `background:${t.color}` : null }),
            h('span', { class: 'finder-tray-text' }, h('strong', { text: `Slot ${t.slot}` }), h('span', { text: t.empty ? 'empty' : trayLabel(t) }), !t.empty && !supported ? h('span', { class: 'finder-file-why', text: 'No P1S preset yet' }) : t.remain != null ? h('span', { class: 'finder-dim', text: `${t.remain}% left` }) : null)
          )
        );
      }
      step1.appendChild(trays);
    }
    sec.appendChild(step1);

    // 2. slice
    const step2 = h('div', { class: 'finder-step', id: 'finder-step-slice' }, h('h4', { class: 'finder-h4', text: '2. Slice' }));
    const canSlice = Boolean(file && print.mapping != null && !print.busy);
    step2.appendChild(h('button', { type: 'button', class: 'finder-btn finder-btn-secondary', id: 'finder-slice-btn', disabled: !canSlice, onClick: doSlice }, print.busy === 'slice' ? 'Slicing...' : print.slice ? 'Slice again' : 'Slice for P1S'));
    if (print.busy === 'slice') step2.appendChild(h('p', { class: 'finder-progress', id: 'finder-print-progress', role: 'status', text: print.message || 'Working...' }));
    if (print.sliceError && !print.busy) step2.appendChild(note('error', print.sliceError));
    if (print.slice) {
      const e = print.slice.estimate || {};
      step2.appendChild(
        h(
          'p',
          { class: 'finder-actionnote is-ok', id: 'finder-slice-done', role: 'status' },
          icon('check'),
          h('span', { text: ` Sliced: ${[e.time, e.grams != null ? e.grams + ' g ' + (print.slice.filament && print.slice.filament.type) : null, e.layers ? e.layers + ' layers' : null].filter(Boolean).join(', ')}. Part size ${print.slice.dims.map((n) => Math.round(n)).join(' x ')} mm.` })
        )
      );
    }
    sec.appendChild(step2);

    // 3. bed check
    const step3 = h('div', { class: 'finder-step', id: 'finder-step-bed' }, h('h4', { class: 'finder-h4', text: '3. Check the bed' }));
    step3.appendChild(h('button', { type: 'button', class: 'finder-btn finder-btn-secondary', id: 'finder-snap-btn', disabled: Boolean(print.busy), onClick: doSnapshot }, print.busy === 'snapshot' ? 'Looking...' : print.snapshot ? 'Look again' : 'Look at the bed'));
    if (print.snapshotError) step3.appendChild(note('error', print.snapshotError));
    if (print.snapshot) {
      step3.appendChild(h('img', { class: 'finder-snapshot', id: 'finder-snapshot', src: print.snapshot.image, alt: 'The print bed, from the chamber camera, just now' }));
      step3.appendChild(
        h(
          'label',
          { class: 'finder-check', for: 'finder-clear' },
          h('input', { type: 'checkbox', id: 'finder-clear', checked: print.confirmed ? true : null, onChange: (e) => { print.confirmed = e.target.checked; renderDetail(); const c = document.getElementById('finder-clear'); if (c) c.focus(); } }),
          h('span', { text: 'The bed is clear. I can see it in this picture.' })
        )
      );
    } else {
      step3.appendChild(h('p', { class: 'finder-dim', text: 'A picture from the printer camera is required before every print.' }));
    }
    sec.appendChild(step3);

    // 4. start
    const step4 = h('div', { class: 'finder-step', id: 'finder-step-start' }, h('h4', { class: 'finder-h4', text: '4. Start' }));
    const ready = st && READY_STATES.includes(st.state);
    const why = !print.slice ? 'Slice the model first.' : !ready ? `The printer is ${(st && st.state) || 'not answering'}; it must be IDLE or FINISH.` : !print.snapshot ? 'Look at the bed first.' : !print.confirmed ? 'Tick "The bed is clear".' : null;
    step4.appendChild(h('button', { type: 'button', class: 'finder-btn finder-btn-primary', id: 'finder-start-btn', disabled: Boolean(why || print.busy), onClick: doStart }, print.busy === 'start' ? 'Starting...' : 'Start print'));
    if (why && !print.start) step4.appendChild(h('p', { class: 'finder-why', id: 'finder-start-why', text: why }));
    if (print.busy === 'start') step4.appendChild(h('p', { class: 'finder-progress', id: 'finder-print-progress', role: 'status', text: print.message || 'Starting...' }));
    if (print.startError) step4.appendChild(note('error', print.startError));
    if (print.start) {
      const pct = st && st.percent != null ? st.percent : 0;
      step4.appendChild(
        h(
          'div',
          { class: 'finder-running', id: 'finder-running', role: 'status' },
          h('p', { class: 'finder-actionnote is-ok' }, icon('check'), h('span', { text: ` Print started.${st ? ' Printer: ' + st.state + (st.percent != null ? ', ' + st.percent + '%' : '') + (st.layer != null && st.totalLayers ? ', layer ' + st.layer + '/' + st.totalLayers : '') + (st.remainingMin ? ', ' + st.remainingMin + ' min left' : '') + '.' : ''}` })),
          h('div', { class: 'finder-meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Print progress' }, h('div', { class: 'finder-meter-fill', style: `width:${Math.max(0, Math.min(100, pct))}%` }))
        )
      );
    }
    sec.appendChild(step4);
    return sec;
  }

  // ── persistence ───────────────────────────────────────────────────────
  function loadSaved() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return { query: typeof v.query === 'string' ? v.query.slice(0, 200) : '', sites: Array.isArray(v.sites) ? v.sites.filter((s) => typeof s === 'string') : [] };
    } catch {
      return { query: '', sites: [] };
    }
  }
  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ query, sites: [...selected] }));
    } catch {
      /* private mode */
    }
  }

  // ── boot ──────────────────────────────────────────────────────────────
  renderChips();
  renderResults();
  if (typeof api.finderCapabilities === 'function') {
    api
      .finderCapabilities()
      .then((c) => {
        if (c && c.ok) {
          caps = c;
          if (Array.isArray(c.sites) && c.sites.length) {
            sites = c.sites;
            selected = new Set([...selected].filter((id) => sites.some((s) => s.id === id && s.available !== false)));
            if (!selected.size) selected = new Set(sites.filter((s) => s.available !== false).map((s) => s.id));
            renderChips();
          }
          if (detail) renderDetail();
        }
      })
      .catch(() => {});
  }

  const handle = {
    state: () => ({ view, query, selected: [...selected], results, detail, print, caps }),
    search: (q) => runSearch(q, { reset: true }),
    open: openDetail,
    back: closeDetail,
    show: showFinder,
  };
  try {
    window.clawscadFinder = handle;
  } catch {
    /* test seam only */
  }
  ctx.finder = handle;
  return handle;
}
