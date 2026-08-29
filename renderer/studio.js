// renderer/studio.js — v0.6 Studio. FOUNDATION STUB.
//
// S1 replaces this file wholesale. It exists now only so the foundation
// (index.html / renderer.js / preload.js / main.js) can be built and verified
// before the feature package lands. Contract: docs/v06-studio-contracts.md §S1.
export function mountStudio(ctx) {
  const root = ctx && ctx.els && ctx.els.studio;
  if (!root) return;
  // Deliberately does nothing: #studio stays [hidden] and the workbench is the
  // view, which is exactly today's behaviour.
}
