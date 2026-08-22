// renderer/composer.js — P1 (composer shell). The right rail's front door:
// target selector, prompt, submit, and the "What Claude will read" preamble.
// Owned exclusively by the composer package.
//
// IMPORTANT: renderer.js is bundled as ESM and ESM imports hoist — this
// module's top-level body runs BEFORE renderer.js's own body finishes. All
// work happens inside mountComposer(ctx), called once at the very end of
// renderer.js's init after `ctx` (renderer/bus.js) is fully populated.

const COMPOSER_MIN = 180; // px — matches --composer-min in style-composer.css
const CONSOLE_MIN = 140; // px — matches --console-min; #terminal must never go below this

const TARGETS = [
  {
    id: 'part',
    label: 'Part',
    placeholder: 'A 40 mm cable clip that snaps onto a 6 mm cable',
    submitLabel: 'Make it',
    timeHint: '',
  },
  {
    id: 'sculpt',
    label: 'Sculpt',
    placeholder: 'A squat owl planter with big round eyes',
    submitLabel: 'Generate & sculpt',
    timeHint: '~10 min',
  },
  {
    id: 'image',
    label: 'Images',
    placeholder: 'A flat vector-style owl mark, black on white',
    submitLabel: 'Generate images',
    timeHint: '~40 s',
  },
];

export function mountComposer(ctx) {
  const root = ctx.els && ctx.els.composer;
  if (!root) return; // guard — P0's container may not exist in a stale harness

  // ── state ────────────────────────────────────────────────────────────
  let target = 'part';
  let prompt = '';
  let submitting = false;
  let degradedReason = null; // set by refreshDegradation(); blocks submit while true
  const sections = new Map(); // id -> { id, order, mount, preamble, blocks, el }
  const submitHandlers = [];

  // ── right-rail restructure ──────────────────────────────────────────
  // The composer goes ABOVE the (demoted, never hidden) terminal, with its
  // own horizontal splitter. #terminal-pane-0 keeps flex:1 so it always
  // fills whatever the composer doesn't take, and style-composer.css floors
  // it at --console-min regardless of composer sizing.
  root.hidden = false;
  const rightPanel = ctx.els.rightPanel || document.getElementById('right-panel');
  const terminalPane0 = document.getElementById('terminal-pane-0');
  let railSplitter = document.getElementById('rail-splitter');
  if (rightPanel && terminalPane0 && !railSplitter) {
    railSplitter = document.createElement('div');
    railSplitter.id = 'rail-splitter';
    railSplitter.setAttribute('role', 'separator');
    railSplitter.setAttribute('aria-orientation', 'horizontal');
    railSplitter.setAttribute('aria-label', 'Resize composer');
    railSplitter.tabIndex = 0;
    rightPanel.insertBefore(railSplitter, terminalPane0);
    wireRailSplitter(railSplitter);
  }

  // ── DOM ──────────────────────────────────────────────────────────────
  root.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'panel-header';
  const headerLabel = document.createElement('span');
  headerLabel.className = 'label';
  headerLabel.textContent = 'Make';
  header.appendChild(headerLabel);
  const headerSpacer = document.createElement('span');
  headerSpacer.className = 'spacer';
  header.appendChild(headerSpacer);
  root.appendChild(header);

  const body = document.createElement('div');
  body.id = 'composer-body';
  root.appendChild(body);

  // Target radiogroup — the largest control after the textarea (master
  // plan §1.1). Never a dropdown, never disabled.
  const targetsEl = document.createElement('div');
  targetsEl.id = 'composer-targets';
  targetsEl.setAttribute('role', 'radiogroup');
  targetsEl.setAttribute('aria-label', 'What to make');
  body.appendChild(targetsEl);

  const targetBtns = {};
  for (const t of TARGETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'target-btn';
    btn.dataset.target = t.id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.textContent = t.label;
    btn.addEventListener('click', () => setTarget(t.id));
    targetsEl.appendChild(btn);
    targetBtns[t.id] = btn;
  }
  targetsEl.addEventListener('keydown', (e) => {
    const ids = TARGETS.map((t) => t.id);
    const idx = ids.indexOf(target);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      setTarget(ids[(idx + 1) % ids.length]);
      targetBtns[target].focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      setTarget(ids[(idx - 1 + ids.length) % ids.length]);
      targetBtns[target].focus();
    }
  });

  // Degradation card — mirrors #gen-empty's / the Claude env-banner's
  // states rather than replacing either element (master plan §2.7 / C4).
  // Additive above the prompt, never hides it, so the required "submit
  // disabled on empty prompt" assertion holds regardless of this machine's
  // env state.
  const setupCard = document.createElement('div');
  setupCard.id = 'composer-setup';
  setupCard.hidden = true;
  body.appendChild(setupCard);

  const promptEl = document.createElement('textarea');
  promptEl.id = 'composer-prompt';
  promptEl.rows = 3;
  promptEl.setAttribute('aria-label', 'Describe what to make');
  promptEl.addEventListener('input', () => {
    prompt = promptEl.value;
    updatePreamble();
    updateSubmitState();
    persistState();
  });
  promptEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  body.appendChild(promptEl);

  // Mount point for P2 (uploads) / P3 (presets) sections — registerSection()
  // inserts sorted by `order`. Empty and invisible until then.
  const sectionsEl = document.createElement('div');
  sectionsEl.id = 'composer-sections';
  body.appendChild(sectionsEl);

  // "What Claude will read" — even with no sections registered yet, this
  // still renders (as just the user's text), so P2/P3 only extend it.
  const preambleEl = document.createElement('details');
  preambleEl.id = 'composer-preamble';
  const preambleSummary = document.createElement('summary');
  preambleSummary.textContent = 'What Claude will read';
  preambleEl.appendChild(preambleSummary);
  const preambleBody = document.createElement('pre');
  preambleBody.id = 'composer-preamble-body';
  preambleEl.appendChild(preambleBody);
  body.appendChild(preambleEl);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.id = 'composer-submit';
  submitBtn.addEventListener('click', () => submit());
  body.appendChild(submitBtn);

  // 1/2/3 switch target when focus is inside the composer but not the
  // textarea; Ctrl/Cmd+K focuses the prompt from anywhere in the app.
  root.addEventListener('keydown', (e) => {
    if (document.activeElement === promptEl) return;
    if (e.key === '1') setTarget('part');
    else if (e.key === '2') setTarget('sculpt');
    else if (e.key === '3') setTarget('image');
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      promptEl.focus();
    }
  });

  // ── behaviour ────────────────────────────────────────────────────────

  function refreshTargetUI() {
    const meta = TARGETS.find((t) => t.id === target);
    for (const t of TARGETS) {
      const btn = targetBtns[t.id];
      const checked = t.id === target;
      btn.setAttribute('aria-checked', checked ? 'true' : 'false');
      btn.tabIndex = checked ? 0 : -1;
      btn.classList.toggle('is-selected', checked);
    }
    promptEl.placeholder = meta.placeholder;
    root.dataset.target = target;
  }

  function setTarget(t, opts) {
    if (!TARGETS.some((x) => x.id === t)) return;
    if (t === target) return;
    target = t;
    refreshTargetUI();
    refreshDegradation();
    updateSubmitState();
    persistState();
    if (!(opts && opts.silent)) promptEl.focus();
  }

  function setPrompt(text, opts) {
    prompt = typeof text === 'string' ? text : '';
    promptEl.value = prompt;
    updatePreamble();
    updateSubmitState();
    persistState();
    if (opts && opts.select) {
      promptEl.focus();
      promptEl.select();
    }
  }

  function collectPreambleLines() {
    const lines = [];
    const ordered = Array.from(sections.values()).sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const s of ordered) {
      if (typeof s.preamble !== 'function') continue;
      try {
        const p = s.preamble();
        if (Array.isArray(p)) {
          for (const line of p) if (line) lines.push(String(line));
        }
      } catch (err) {
        console.error('[composer] section preamble() threw', s.id, err);
      }
    }
    return lines;
  }

  function composeMessage() {
    const manifest = collectPreambleLines();
    const userText = prompt.trim();
    const parts = [];
    if (manifest.length) parts.push(manifest.join('\n'));
    if (userText) parts.push(userText);
    return parts.join('\n\n');
  }

  function updatePreamble() {
    const composed = composeMessage();
    preambleBody.textContent = composed || '(nothing yet — type something above, or attach a file)';
  }

  function firstBlockingSection() {
    for (const s of sections.values()) {
      if (typeof s.blocks !== 'function') continue;
      try {
        const reason = s.blocks();
        if (typeof reason === 'string' && reason) return reason;
      } catch (err) {
        console.error('[composer] section blocks() threw', s.id, err);
      }
    }
    return null;
  }

  function updateSubmitState() {
    const blockingReason = firstBlockingSection();
    const emptyPrompt = !prompt.trim() && collectPreambleLines().length === 0;
    const meta = TARGETS.find((t) => t.id === target);
    const disabled = emptyPrompt || !!blockingReason || !!degradedReason || submitting;
    submitBtn.disabled = disabled;
    submitBtn.setAttribute('aria-disabled', String(disabled));
    if (submitting) {
      submitBtn.textContent = 'Sending…';
    } else if (emptyPrompt) {
      // A disabled button that still says "Make it" reads as broken rather
      // than as waiting (ux-spec §2.7).
      submitBtn.textContent = 'Describe something first';
    } else {
      submitBtn.textContent = meta.timeHint ? `${meta.submitLabel}   ${meta.timeHint}` : meta.submitLabel;
    }
    submitBtn.title = blockingReason || degradedReason || '';
  }

  function showSetupCard({ title, body: text, actions }) {
    setupCard.innerHTML = '';
    setupCard.hidden = false;
    setupCard.className = 'composer-setup-card';
    const strong = document.createElement('strong');
    strong.textContent = title;
    setupCard.appendChild(strong);
    const p = document.createElement('p');
    p.textContent = text;
    setupCard.appendChild(p);
    const actionsEl = document.createElement('div');
    actionsEl.className = 'composer-setup-actions';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'small-btn';
      btn.textContent = action.text;
      btn.addEventListener('click', action.run);
      actionsEl.appendChild(btn);
    }
    setupCard.appendChild(actionsEl);
  }

  async function refreshDegradation() {
    degradedReason = null;
    setupCard.hidden = true;
    setupCard.innerHTML = '';

    if (!ctx.api) {
      updateSubmitState();
      return;
    }

    try {
      if (target === 'part') {
        const env = ctx.api.getEnvStatus ? await ctx.api.getEnvStatus() : null;
        if (env && env.claude && !env.claude.binary) {
          degradedReason = 'Claude Code CLI is not installed.';
          showSetupCard({
            title: 'Claude Code CLI needed to make parts.',
            body: 'The composer writes your prompt to the Claude Code terminal on the right. Install the CLI, then try again.',
            actions: [{ text: 'Setup guide', run: () => ctx.api.openReadme() }],
          });
        }
      } else {
        const result = ctx.api.getPipelineBackends ? await ctx.api.getPipelineBackends() : null;
        if (!result || !result.configured) {
          degradedReason = 'The claw-gen pipeline is not configured.';
          const cliError = result && result.state === 'cli-error';
          showSetupCard({
            title: cliError ? 'claw-gen failed to start.' : 'Sculpting needs the claw-gen pipeline.',
            body: cliError
              ? `${result.cli} ran but produced nothing usable.`
              : 'It turns a sentence into images, then into a 3D checkpoint you can branch and cut into.',
            actions: [
              {
                text: 'Locate claw-gen…',
                run: async () => {
                  const res = await ctx.api.locatePipelineCli();
                  if (res && !res.canceled) {
                    if (ctx.showToast) ctx.showToast(res.resolved ? `Using ${res.resolved}` : 'That file did not resolve as claw-gen', res.resolved ? 'success' : 'error');
                  }
                  refreshDegradation();
                },
              },
              { text: 'Setup guide', run: () => ctx.api.openReadme() },
            ],
          });
        }
      }
    } catch (err) {
      console.error('[composer] refreshDegradation failed', err);
    }
    updateSubmitState();
  }

  async function dispatchPart() {
    const message = composeMessage();
    if (!message) return;
    const ok = ctx.api && ctx.api.composerSendToClaude ? await ctx.api.composerSendToClaude(message) : false;
    if (!ok) {
      if (ctx.showToast) ctx.showToast("Couldn't reach the Claude Code terminal — is it running?", 'error');
      return;
    }
    if (ctx.showToast) ctx.showToast('Sent to Claude', 'success');
  }

  async function dispatchGenerate() {
    // Never bypass the existing handler — fill #gen-prompt and invoke the
    // same #gen-generate-btn click it already responds to (master plan
    // §1.1/C5; renderer.js:2118-2119 reads #gen-prompt directly and must
    // keep doing so).
    const genPromptEl = document.getElementById('gen-prompt');
    const genBtn = document.getElementById('gen-generate-btn');
    if (!genPromptEl || !genBtn) {
      if (ctx.showToast) ctx.showToast('The Generate panel is not available', 'error');
      return;
    }
    genPromptEl.value = prompt.trim();
    genBtn.click();
  }

  async function submit() {
    if (submitBtn.disabled || submitting) return;
    submitting = true;
    updateSubmitState();
    try {
      const payload = { target, prompt: prompt.trim(), sections: Array.from(sections.keys()) };
      for (const cb of submitHandlers) {
        // Sequential await — this is the entire coupling between P2's
        // upload ingest and the composer (master plan §4.3): ingest must
        // finish BEFORE the prompt is dispatched.
        // eslint-disable-next-line no-await-in-loop
        await cb(payload);
      }
      if (target === 'part') await dispatchPart();
      else await dispatchGenerate();
    } catch (err) {
      console.error('[composer] submit failed', err);
      if (ctx.showToast) ctx.showToast('Something went wrong sending that — see devtools console', 'error');
    } finally {
      submitting = false;
      updateSubmitState();
    }
  }

  function registerSection(section) {
    if (!section || !section.id || sections.has(section.id) || typeof section.mount !== 'function') return;
    const wrapper = document.createElement('div');
    wrapper.className = 'composer-section';
    wrapper.dataset.sectionId = section.id;
    const record = { ...section, el: wrapper };
    sections.set(section.id, record);

    const order = typeof section.order === 'number' ? section.order : 0;
    let inserted = false;
    for (const child of Array.from(sectionsEl.children)) {
      const other = sections.get(child.dataset.sectionId);
      if (other && (other.order || 0) > order) {
        sectionsEl.insertBefore(wrapper, child);
        inserted = true;
        break;
      }
    }
    if (!inserted) sectionsEl.appendChild(wrapper);

    try {
      section.mount(wrapper);
    } catch (err) {
      console.error('[composer] section mount() threw', section.id, err);
    }
    refresh();
  }

  function refresh() {
    updatePreamble();
    updateSubmitState();
  }

  // ── rail splitter drag/resize ──────────────────────────────────────
  function wireRailSplitter(splitter) {
    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    function clampHeight(h) {
      const total = rightPanel.getBoundingClientRect().height || 800;
      const max = Math.max(COMPOSER_MIN, total - CONSOLE_MIN - splitter.offsetHeight);
      return Math.min(max, Math.max(COMPOSER_MIN, h));
    }

    splitter.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      startHeight = root.getBoundingClientRect().height;
      splitter.classList.add('active');
      document.body.classList.add('dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      root.style.height = clampHeight(startHeight + (e.clientY - startY)) + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('active');
      document.body.classList.remove('dragging');
      persistState();
    });

    splitter.addEventListener('keydown', (e) => {
      const step = 16;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        root.style.height = clampHeight(root.getBoundingClientRect().height - step) + 'px';
        persistState();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        root.style.height = clampHeight(root.getBoundingClientRect().height + step) + 'px';
        persistState();
      } else if (e.key === 'Home') {
        e.preventDefault();
        root.style.height = COMPOSER_MIN + 'px';
        persistState();
      }
    });
  }

  // ── state persistence — userData/composer-state.json, never
  // clawscad.json (master plan §1.15 / R5) ────────────────────────────
  let persistTimer = null;
  function persistState() {
    if (!ctx.api || !ctx.api.composerSetState) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const heightPx = root.style.height ? parseInt(root.style.height, 10) : null;
      ctx.api.composerSetState({ target, prompt, height: heightPx || undefined }).catch(() => {});
    }, 250);
  }

  async function loadPersistedState() {
    if (!ctx.api || !ctx.api.composerGetState) return;
    try {
      const state = await ctx.api.composerGetState();
      if (!state || typeof state !== 'object') return;
      if (typeof state.target === 'string' && TARGETS.some((t) => t.id === state.target)) {
        target = state.target;
      }
      if (typeof state.prompt === 'string') {
        prompt = state.prompt;
        promptEl.value = prompt;
      }
      if (typeof state.height === 'number' && state.height >= COMPOSER_MIN) {
        root.style.height = state.height + 'px';
      }
      refreshTargetUI();
      updatePreamble();
      updateSubmitState();
      refreshDegradation();
    } catch (err) {
      console.error('[composer] failed to load composer-state.json', err);
    }
  }

  // ── initial render ──────────────────────────────────────────────────
  refreshTargetUI();
  updatePreamble();
  updateSubmitState();
  refreshDegradation();
  loadPersistedState();

  // ── freeze the interface (master plan §4.3) — LAST step of mount, so
  // P2/P3/P5 never observe a partially-built ctx.composer.
  ctx.composer = {
    getTarget: () => target,
    setTarget,
    getPrompt: () => prompt,
    setPrompt,
    registerSection,
    refresh,
    onSubmit: (cb) => {
      if (typeof cb === 'function') submitHandlers.push(cb);
    },
  };
}
