// renderer/bus.js — the renderer-side interface for every feature package
// (P1 composer, P2 uploads, P3 presets, P4 gallery, P5 onboarding).
//
// renderer.js is one flat ES module that owns the DOM and every IPC
// subscription; new modules under renderer/ must never reach into
// renderer.js internals directly — they read and write only through the
// `ctx` object exported here.
//
// `ctx` is intentionally mutable and shared by reference. renderer.js sets
// every field below exactly once, at the very end of its own module body
// (after animate() starts, at the clawscad:anchor:modules block — by then
// every handle a feature module could need already exists). Feature modules
// import `ctx` and read it lazily, inside their own mountX(ctx) function —
// NEVER at module import time. ESM imports hoist: a module's top-level body
// runs before renderer.js's own body does, so any field read at import time
// would still be null/''/empty.
export const ctx = {
  api: null,              // window.api                              renderer.js (preload bridge)
  showToast: null,        // (msg, type) => void                     renderer.js:12
  setExpanded: null,      // (panel, toggle, collapsed) => void      renderer.js:156
  updateStatus: null,     // (msg) => void                           renderer.js:2368
  prettyPath: null,       // (p) => string                           renderer.js:2376
  workspaceDir: '',       // kept in sync in place once window.api.getWorkspace() resolves — may still be '' briefly at mount time
  els: {},                // a handful of shared containers, keyed by short name — see the clawscad:anchor:modules block in renderer.js
  composer: null,         // filled by P1 once its module mounts — shape frozen in master plan §4.3; null until then
  onCheckpointsChanged,   // (cb) => void — fan-out subscription, see below
};

// The raw window.api.onCheckpointUpdate registrar has no unsubscribe, so it
// must be called exactly once, by renderer.js (standing rule 4 — a second
// registration would stack handlers silently). Every feature module that
// wants checkpoint updates subscribes here instead of calling the registrar
// itself.
const _subscribers = [];

function onCheckpointsChanged(cb) {
  if (typeof cb === 'function') _subscribers.push(cb);
}

// Called ONLY from renderer.js's single window.api.onCheckpointUpdate
// handler, to fan the event out to every subscriber registered above.
export function notifyCheckpointsChanged(state) {
  for (const cb of _subscribers) {
    try {
      cb(state);
    } catch (err) {
      console.error('[bus] onCheckpointsChanged subscriber threw', err);
    }
  }
}
