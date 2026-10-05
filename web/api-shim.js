// web/api-shim.js — the browser-side half of the web port.
//
// Implements the subset of preload.js's `window.api` that renderer/studio.js
// actually calls, over `fetch` + `EventSource`, so mountStudio(ctx) cannot tell
// the difference between this and the Electron contextBridge. Every method
// keeps the EXACT return shape studio.js branches on — a Promise<boolean> where
// preload returns one, a bare array where preload returns one, `null` (not a
// rejection) where preload returns null.
//
// Three rules, each of which has a wrong-looking alternative:
//
//  1. NEVER reject. preload's ipcRenderer.invoke rejects only when there is no
//     handler; every studio call site treats a rejection as a crash and logs it.
//     Network faults are far more common here than on an IPC bus, so every
//     method resolves to the shape's own "it didn't work" value instead.
//  2. NEVER fake success. composerSendToClaude resolves `false`, which is
//     exactly what makes the Studio's degradation path fire.
//  3. Registrars (`on*`) are called once by entry.js, never twice — the same
//     standing rule the Electron renderer lives under, for the same reason
//     (there is no unsubscribe).

const NO_PATH_REASON =
  'The browser port cannot read a file by path — pick one with the button, or drop it on the card.';

/**
 * @param {object} opts
 * @param {string} [opts.base]         API origin; defaults to same-origin.
 * @param {(reason:string)=>void} [opts.onUnsupported]
 *        Called with a plain-English reason whenever a genuinely unavailable
 *        operation is attempted (checkpoint open, locate claw-gen, …). entry.js
 *        wires it to showToast so nothing is ever a silently dead button.
 */
/**
 * Turn a send-to-claude refusal into { code, reason } a person can act on.
 * `res` is null when the request never got a JSON answer — a dropped
 * connection, or an expired Cloudflare Access sign-in redirecting the call.
 */
export function describeSendFailure(res) {
  if (!res) {
    return {
      code: 'no-answer',
      reason: 'The ClawSCAD server did not answer. Reload the page (your sign-in may have expired) and try again.',
    };
  }
  const code = res.error || 'refused';
  if (code === 'already-running') {
    const secs = res.startedAt ? Math.max(0, Math.round((Date.now() - res.startedAt) / 1000)) : null;
    const age = secs == null ? '' : secs < 90 ? ` ${secs} seconds ago` : ` ${Math.round(secs / 60)} minutes ago`;
    return {
      code,
      reason: `A build is already running (started${age}). Wait for it to finish, or stop it in the Workbench, then try again.`,
    };
  }
  if (code === 'no-brief') return { code, reason: 'Tell me what it is first — a few words is plenty.' };
  return { code, reason: res.reason || `The server could not start the build (${code}).` };
}

export function createApiShim(opts = {}) {
  const base = (opts.base || '').replace(/\/+$/, '');
  const onUnsupported = typeof opts.onUnsupported === 'function' ? opts.onUnsupported : () => {};

  const pipelineSubs = [];
  const logSubs = [];
  const exitSubs = [];
  const makeSubs = [];
  const makeLogSubs = [];
  const renderSubs = [];

  // Results of a picker choice, keyed by the token uploadPick() hands back. The
  // Studio's flow C is `uploadPick() -> [paths]` then `uploadIngest(paths[0])`,
  // and a browser has no paths at all, so the pick does the ingest and the
  // "path" is a claim ticket for its result. Same call sequence, same shapes,
  // no change in studio.js.
  const pickResults = new Map();

  async function json(path, init) {
    try {
      const res = await fetch(base + path, init);
      const text = await res.text();
      if (!text) return { __httpStatus: res.status };
      const body = JSON.parse(text);
      if (body && typeof body === 'object' && !Array.isArray(body)) body.__httpStatus = res.status;
      return body;
    } catch (err) {
      console.error('[web-api]', path, err);
      return null;
    }
  }

  const api = {
    // ── tools / categories ────────────────────────────────────────────────
    toolsLoad: () => json('/api/tools'),
    categoriesLoad: () => json('/api/categories'),

    // ── environment ───────────────────────────────────────────────────────
    getEnvStatus: () => json('/api/env'),
    getWorkspace: async () => {
      const res = await json('/api/workspace');
      return (res && res.workspace) || '';
    },

    // ── composer state ────────────────────────────────────────────────────
    composerGetState: () => json('/api/composer/state'),
    composerSetState: async (state) => {
      const res = await json('/api/composer/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      return res === true;
    },

    /**
     * There is no pty in a browser. The desktop app writes the composed brief
     * into a live Claude Code session's stdin through node-pty; nothing here
     * can. Resolving `false` is the honest answer and is what the Studio's
     * §S1 degradation table is written against — it raises a notice naming the
     * reason and offers the routes that still work. Resolving `true` would send
     * the user to a Workbench that never received anything.
     */
    // Flow A. This used to resolve `false` with a "no pty in a browser"
    // reason — but Flow A never needed a pty. `claude -p` runs headless on the
    // server and exits; the .scad it writes is found by diffing the workspace,
    // not by trusting the model to report a path. Resolving TRUE here is what
    // makes the Studio's normal Flow A path fire instead of its degradation.
    //
    // A refusal is NOT "couldn't reach Claude". The commonest one is a second
    // click while the first build still runs (409 already-running), and the
    // Studio used to report that as an unreachable terminal. The real reason is
    // kept on `lastSendFailure` so studio.js can say what actually happened.
    composerSendToClaude: async (message) => {
      api.lastSendFailure = null;
      const res = await json('/api/composer/send-to-claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: String(message == null ? '' : message) }),
      });
      if (res && res.ok) return true;
      const failure = describeSendFailure(res);
      api.lastSendFailure = failure;
      console.info('[web-api] composer:send-to-claude refused —', failure.code, failure.reason);
      onUnsupported(failure.reason);
      return false;
    },
    lastSendFailure: null,

    cancelMake: () => json('/api/make/cancel', { method: 'POST' }),
    makeStatus: () => json('/api/make/status'),

    // ── models: customize + export ────────────────────────────────────────
    listModels: () => json('/api/models'),
    modelParams: (file) => json(`/api/model/params?file=${encodeURIComponent(file)}`),
    renderPreview: (file, values) =>
      json('/api/model/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, values }),
      }),
    exportModel: (file, values, format) =>
      json('/api/model/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, values, format }),
      }),

    // ── pipeline ──────────────────────────────────────────────────────────
    getPipelineBackends: () => json('/api/pipeline/backends'),

    startPipeline: (opts2) =>
      json('/api/pipeline/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts2 || {}),
      }).then((r) => r || { error: 'the server did not answer' }),

    cancelPipeline: () => json('/api/pipeline/cancel', { method: 'POST' }).then((r) => r === true),

    /**
     * Web-only — preload has no equivalent because Electron never needs one: in
     * the desktop app the run and the window die together. Here the server
     * outlives the tab, so a tab that opens mid-chain has to be able to ASK.
     */
    getPipelineStatus: () => json('/api/pipeline/status'),

    /**
     * preload returns a `data:` URI; this returns a same-origin URL to the
     * bytes, which is strictly better here — no base64 inflation over the
     * tunnel, and the browser can cache-bust and stream it. studio.js only ever
     * assigns it to `img.src`, and only branches on truthiness, so the shape
     * holds. The HEAD probe is what keeps that branch honest: a URL that would
     * 404 resolves to `null` so the "Picture unavailable" tile renders instead
     * of a broken image.
     */
    readPipelineImage: async (filePath) => {
      if (typeof filePath !== 'string' || !filePath) return null;
      const url = `${base}/api/pipeline/image?path=${encodeURIComponent(filePath)}`;
      try {
        const head = await fetch(url, { method: 'HEAD' });
        return head.ok ? url : null;
      } catch (err) {
        console.error('[web-api] readPipelineImage', err);
        return null;
      }
    },

    onPipelineEvent: (cb) => {
      if (typeof cb === 'function') pipelineSubs.push(cb);
    },
    onPipelineLog: (cb) => {
      if (typeof cb === 'function') logSubs.push(cb);
    },
    onPipelineExit: (cb) => {
      if (typeof cb === 'function') exitSubs.push(cb);
    },

    /**
     * The desktop app opens a native dialog and then locates claw-gen on disk.
     * A browser cannot browse the SERVER's filesystem, and exposing a remote
     * file picker behind a tunnel would be a genuinely bad idea. Says so.
     */
    locatePipelineCli: async () => {
      onUnsupported(
        'claw-gen is located on the machine that runs the server. Set CLAWSCAD_CLI, or put its path in ' +
          'pipeline-settings.json in the state directory, and restart.'
      );
      return { canceled: true, userSet: null, resolved: null };
    },

    // ── uploads ───────────────────────────────────────────────────────────
    //
    // preload's `pathForFile` uses Electron's webUtils, which exists only in a
    // preload script. In a browser a File has no path at all — returning null
    // is the truthful answer, and it is exactly what studio.js's drop handler
    // already falls back from (it calls uploadIngestBytes instead).
    pathForFile: () => null,

    /**
     * `upload:pick` has no browser equivalent, so this drives a hidden
     * <input type=file> instead and ingests the chosen file immediately. It
     * returns a one-element array of an opaque token so the Studio's
     * pick-then-ingest sequence works unchanged; uploadIngest() redeems it.
     * An empty array means "cancelled", which studio.js correctly treats as
     * "say nothing".
     */
    uploadPick: () =>
      new Promise((resolve) => {
        const input = document.getElementById('web-file-input');
        if (!input) {
          onUnsupported('The file picker is missing from this page.');
          resolve([]);
          return;
        }
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          input.removeEventListener('change', onChange);
          input.removeEventListener('cancel', onCancel);
          resolve(value);
        };
        const onChange = async () => {
          const file = input.files && input.files[0];
          input.value = '';
          if (!file) return finish([]);
          const token = `web-pick:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
          pickResults.set(token, await api.uploadIngestBytes(file.name, file));
          finish([token]);
        };
        // Chromium fires `cancel` on dismissal; older engines do not, so a
        // focus-return fallback keeps the promise from hanging forever.
        const onCancel = () => finish([]);
        input.addEventListener('change', onChange, { once: true });
        input.addEventListener('cancel', onCancel, { once: true });
        window.addEventListener(
          'focus',
          () => setTimeout(() => {
            if (!input.files || !input.files.length) finish([]);
          }, 400),
          { once: true }
        );
        input.click();
      }),

    uploadIngest: async (token) => {
      if (typeof token === 'string' && pickResults.has(token)) {
        const result = pickResults.get(token);
        pickResults.delete(token);
        return result;
      }
      return { ok: false, error: NO_PATH_REASON };
    },

    /**
     * `bytes` is a Uint8Array from studio.js's drop path, or a File from
     * uploadPick above. Both are valid fetch bodies, so neither is copied.
     */
    uploadIngestBytes: async (name, bytes) => {
      try {
        const res = await fetch(`${base}/api/upload/ingest-bytes?name=${encodeURIComponent(String(name || 'upload'))}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        });
        return await res.json();
      } catch (err) {
        console.error('[web-api] uploadIngestBytes', err);
        return { ok: false, error: 'That upload did not reach the server.' };
      }
    },

    uploadList: () => json('/api/upload/list'),

    // ── checkpoints (read-only mirror of the desktop registry) ────────────
    getCheckpoints: () => json('/api/checkpoints').then((r) => r || { checkpoints: {}, active: null }),

    /**
     * Real, since the browser has a Workbench of its own. `active.scad` is the
     * one file this port writes, and it is not the registry: clawscad.json
     * still belongs to the desktop app. studio.js calls this with an ID alone
     * and branches on a Promise<boolean>, so the shape is unchanged — the
     * server resolves an ID against the reconciled list when no file is given.
     */
    selectCheckpoint: async (id, file) => {
      const res = await json('/api/checkpoint/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id == null ? null : String(id), file: file || null }),
      });
      if (res && res.ok) return true;
      onUnsupported((res && res.error) || 'That model could not be opened.');
      return false;
    },

    /** Ask the server for a mesh of this .scad — a sibling export if one is
     *  there, an OpenSCAD render if not. Never rejects (rule 1). */
    checkpointMesh: (file) =>
      json(`/api/checkpoint/mesh?file=${encodeURIComponent(file)}`).then(
        (r) => r || { ok: false, error: 'The server did not answer.', fault: 'environment' }
      ),

    readModelSource: (file) => json(`/api/model/source?file=${encodeURIComponent(file)}`),

    /** Inline bytes for the viewport; `downloadUrl` is the attachment twin. */
    modelFileUrl: (p) => `${base}/api/model/file?path=${encodeURIComponent(p)}`,
    downloadUrl: (p) => `${base}/api/model/download?path=${encodeURIComponent(p)}`,

    onRenderEvent: (cb) => {
      if (typeof cb === 'function') renderSubs.push(cb);
    },

    openReadme: async () => {
      onUnsupported('The setup guide is in the repository README on the machine hosting this server.');
      return false;
    },

    onMakeEvent: (cb) => {
      if (typeof cb === 'function') makeSubs.push(cb);
    },
    onMakeLog: (cb) => {
      if (typeof cb === 'function') makeLogSubs.push(cb);
    },
  };

  /**
   * Opens the SSE stream and fans it into the registrars above. Called once,
   * by entry.js. EventSource reconnects on its own after a tunnel blip, which
   * is the main reason this is SSE and not a hand-rolled long poll.
   */
  api.connect = function connect() {
    const source = new EventSource(base + '/events');
    source.onmessage = (msg) => {
      let envelope;
      try {
        envelope = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (!envelope || typeof envelope !== 'object') return;
      const subs =
        envelope.channel === 'pipeline:event'
          ? pipelineSubs
          : envelope.channel === 'pipeline:log'
            ? logSubs
            : envelope.channel === 'pipeline:exit'
              ? exitSubs
              : envelope.channel === 'make:event'
                ? makeSubs
                : envelope.channel === 'make:log'
                  ? makeLogSubs
                  : envelope.channel === 'render:event'
                    ? renderSubs
                    : null;
      if (!subs) return;
      for (const cb of subs) {
        try {
          cb(envelope.data);
        } catch (err) {
          console.error('[web-api] subscriber threw', err);
        }
      }
    };
    // Flow A + Customize live on the same stream. `make:*` is a separate
    // channel from `pipeline:*` because a headless Claude run and a claw-gen
    // run are different jobs with different lifecycles, and collapsing them
    // would make one look like the other in the Studio's stepper.
    source.addEventListener('message', () => {});
    source.onerror = () => {
      // EventSource retries by itself (the server sends `retry: 3000`); logging
      // once per drop is enough and a toast per blip would be noise.
      console.warn('[web-api] event stream dropped — reconnecting');
    };
    return source;
  };

  return api;
}
