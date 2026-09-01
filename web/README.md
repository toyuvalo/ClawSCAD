# ClawSCAD Studio — web port

The v0.6 **Make** view, self-hostable behind a Cloudflare Access tunnel. It runs
`renderer/studio.js` **unmodified**: the same 2,200 lines that ship in the
Electron app, mounted by `web/entry.js` against a `window.api` shim that speaks
`fetch` + `EventSource` instead of `ipcRenderer`.

Nothing outside `web/` is modified. The stylesheets are served from the repo
root (`/style.css`, `/style-studio.css`) rather than copied, so the dashboard
cannot drift from S2's sheet.

```
web/
  server.js     zero-dependency node:http server + the API + the SSE stream
  api-shim.js   the browser half of that API, shaped exactly like preload.js
  entry.js      builds ctx, owns the #gen-* call sites, calls mountStudio(ctx)
  index.html    the shell: #studio, #main-content, #toast-container, #gen-*
  web.css       the few shell-only rules; touches no #studio selector
  build.js      esbuild → web/dist/app.js
```

## Running it

```sh
node web/build.js                              # → web/dist/app.js  (esbuild)
node web/server.js --workspace /path/to/workspace
```

Open **http://127.0.0.1:8730**.

| flag / env | default | what it is |
|---|---|---|
| `--workspace` / `$CLAWSCAD_WORKSPACE` | `~/clawscad-workspace` | claw-gen's cwd, and the **only** directory this server will read files from |
| `--state` / `$CLAWSCAD_STATE_DIR` | `<workspace>/.clawscad-web` | the web port's `userData`: `composer-state.json`, `pipeline-settings.json`, and optional `presets/` overrides |
| `--port` / `$PORT` | `8730` | not 3000/8080/8788 on purpose — this shares a machine with dev servers |
| `--host` / `$CLAWSCAD_HOST` | `127.0.0.1` | loopback only; `cloudflared` connects over it |
| `--cli` / `$CLAWSCAD_CLI` | — | path to `claw-gen`. Falls back to `<state>/pipeline-settings.json`'s `cliPath`, then `PATH` |

`node web/build.js --watch` rebuilds on every change to `web/*.js` or
`renderer/*.js`. `--minify` for a production bundle.

**Rebuild after any `renderer/*.js` edit.** The desktop app's standing rule 4
applies here for the same reason: the bundle is what runs, not the source.

### Deploying

Run it under whatever supervises services on the host (`launchd`, `systemd`),
point `cloudflared` at `http://127.0.0.1:8730`, and put Cloudflare Access in
front. There is **no authentication in this server** — Access is the entire
auth story, and the loopback bind is what stops anything else reaching it.

## What works, and what does not

The Studio's own §S1 degradation table is the contract; this port fires the same
paths, with the reason stated on screen rather than a dead control.

| | |
|---|---|
| **Type grid + tools** | Fully. `tools:load` / `categories:load` go through `main/tools.js`'s `loadTools()` and `main/categories.js`'s `loadCategories()` — the same files the desktop app calls, including the `userData/presets/` override rules. |
| **The routing decision** | Fully. `renderer/route.js` is pure and runs in the bundle. |
| **State persistence** | Fully. `composer:set-state` reuses `main/composer.js`'s `mergeState`, so the top-level merge and the `{}`-means-clear reset behave identically. |
| **Flow B — pictures first** | Fully. `claw-gen images` runs on the host with `cwd` = workspace and `--json-events`; NDJSON lines are streamed to the browser over SSE. Rounds, refine and "more like this" all continue the same job. |
| **Flow C — recreate an upload** | Fully, for images. `mesh --image <relPath> --new-job` runs and chains mesh → prep → checkpoint **on the server** (v0.6.2) — closing the tab mid-mesh no longer strands it. |
| **Upload** | Images only (png, jpg, webp, svg, dxf). `upload:pick` has no browser equivalent, so the shim drives a hidden `<input type=file>`; drag-and-drop goes through `upload:ingest-bytes`. Files land in `<workspace>/uploads/` via `main/uploads.js`'s own `storeUnique` (hash on collision, never overwrite) and are recorded in `uploads/uploads.json`. |
| **Flow A — "Make it" straight to Claude** | **Yes** (v0.6.1). It never needed a pty: `claude -p --permission-mode acceptEdits` runs headless in the workspace and exits. Progress streams on the `make:*` SSE channel; the produced `.scad` is found by **diffing the workspace's `.scad` mtimes**, not by trusting the model to report a path. One make at a time, 10-minute ceiling, killed as a process tree on cancel. |
| **Customize + export** | **Yes** (v0.6.1). `web/scad-params.mjs` parses OpenSCAD's own Customizer syntax; the values are applied with `-D`, which is OpenSCAD's own mechanism. Preview is a server-side PNG, so it cannot drift from the artifact the way a client-side re-mesh could. **3MF** is the primary export (STL secondary). |
| **Workbench** | **No.** The three.js viewport, the `node-pty` terminal and the checkpoint tree are absent. The Workbench tab leads to a panel naming each one. (OpenSCAD *rendering* now exists — for Customize — but not the interactive viewport.) |
| **Opening a checkpoint** | **No.** `clawscad.json` is read (so "pick up where you left off" lists real work) but never written, and selecting one explains that it needs the desktop app. The list is **reconciled in memory** (v0.6.3) — see the note below. |
| **Locate claw-gen…** | **No.** A browser cannot browse the server's filesystem, and exposing a remote file picker behind a tunnel would be a bad idea. Set `CLAWSCAD_CLI` instead. |
| **Editing the `.scad`** | **No, deliberately.** Customize never rewrites the file — every value goes through `-D`. Each `.scad` is an immutable checkpoint, and a UI that edited them to "customize" would be the easiest possible way to break that promise. |

## Notes for whoever touches this next

- **`claw-gen`'s `job_root` must be inside the workspace.** Candidate images are
  served by `/api/pipeline/image`, which refuses any path that does not resolve
  inside the workspace (and, once a job is running, inside that job's directory).
  A `job_root` pointing elsewhere makes every picture render as
  "Picture unavailable" — correctly, but confusingly.
- **One pipeline child per server**, mirroring Electron's one-per-window. A
  second browser tab starting a run gets `already-running`, and every connected
  tab sees every event. That is the honest behaviour for a single-user
  self-host; it is not multi-tenant.
- **The `mesh → prep → checkpoint` chain runs on the SERVER, and this is the one
  place the port deliberately does *not* mirror the desktop.** `renderer.js`
  chains those stages itself off a `genPendingStage` variable, which is safe in
  Electron because the renderer *is* the app — close the window and there is no
  run left to strand. In a tab it is not: on 2026-08-30 a real generation
  finished its images and a watertight 516K-vertex mesh and then stopped, `prep`
  and `checkpoint` still `pending`, because the tab had closed during the
  ~10-minute mesh. Ten minutes of GPU work, finished on disk, no checkpoint, and
  nothing on screen to say so. So the client declares the chain once
  (`chain: ['prep','checkpoint']` on the head stage) and the server carries it to
  the end — `sseSend` to zero clients is a no-op, not an error, which is the
  whole reason it works. Consequences worth knowing before you edit it:
  - `pipeline:exit` carries **`chained`**, naming the stage the server has
    *already started*. A client that sees it must keep its controls locked and
    start nothing — the run is not over. `entry.js` returning early on `chained`
    is what stops `#gen-generate-btn` flickering `disabled` off between stages,
    which `studio.js`'s `watchRun()` would read as "the run ended".
  - **`GET /api/pipeline/status`** exists for the case Electron never has: a tab
    opening *mid-run*. Without it a re-opened tab looks idle and collects an
    `already-running` on the next click.
  - Only a **clean exit advances**, and `/api/pipeline/cancel` disarms the chain
    before it kills anything. Both are load-bearing and both are mutation-proven
    in `tests/pipeline-chain.js` — note that the cancel path alone does *not*
    prove the exit-code guard, which is why there is a separate check that makes
    a stage fail on its own.
  - `chain` arrives off the network, so it is bounded, de-duplicated, and refused
    if it re-enters the head stage. `['mesh','mesh',…]` would otherwise be a
    self-restarting GPU job with no button to stop it.
- **The `#gen-*` elements in `index.html` are off-screen, not inert.** `studio.js`
  writes `#gen-prompt`, clicks `#gen-generate-btn`, clicks a
  `.gen-candidate[data-key]`, then clicks `#gen-make3d-btn`, and it reads
  `#gen-generate-btn.disabled` through a `MutationObserver` as its *only*
  end-of-run signal. `entry.js` owns their behaviour exactly as `renderer.js`
  does on the desktop. Remove one and the picture step goes silently dead. Add
  `debug-gen` to `<body>` to see the panel.
- **The checkpoint list is reconciled IN MEMORY, and that is not a shortcut.**
  `main.js` has `reconcileWorkspace()`, which adopts `.scad` files that exist on
  disk but are missing from the registry; its comment explains that the watcher
  starts `ignoreInitial: true`, so anything made while the app was closed "was
  invisible forever". This port has no watcher *and* had no reconcile, so that
  failure was not merely possible here — it was the **default**: `claw-gen
  checkpoint`, which is how the server-side chain now ends, writes the `.scad`
  and nothing writes the registry. The 2026-08-30 cheese-man sculpt sat finished
  on disk with a 3MF and a render beside it and the browser listed nothing.
  `reconcileCheckpoints()` adopts on read and **never writes** — `clawscad.json`
  belongs to the desktop app (design rule 4), and a second writer on a shared
  JSON is exactly the `composer-state.json` bug this release already paid for.
  `tests/web-visibility.js` holds that line by comparing the file's **bytes**
  before and after, because a reformat is still a write. Adopted ids are derived
  from the filename (`web_adopted_…`), not random, so the list does not reorder
  itself on every poll, and namespaced so they can never collide with the ids
  the desktop app will eventually assign.
- **The image gate has TWO roots, and it needs both.** `serveWorkspaceImage`
  narrows reads to the current job dir once a job has produced a candidate —
  keep that. But `customize.js` loads its preview from `renders/web/<model>.png`,
  which *this server wrote*, and `pipelineJobDir` is never cleared. With one
  root, a single image generation 403'd every Customize preview **for the life
  of the process**, silently: the note said "Rendered" and the `<img>` stayed
  empty. Electron gets away with the same code because its window restarts
  constantly; this server runs for days behind a tunnel. Widened to the render
  dir, **not** removed — there is a test that an unrelated workspace image is
  still refused, and it is the one that fails if someone "simplifies" this.
- **Path handling is the security boundary.** `containedInWorkspace()` resolves
  and `realpath`s both ends and compares with `path.relative` — it does not
  filter `..`, because an absolute path on another drive and a symlink out of
  the tree both contain none.
- **No CORS headers, deliberately.** Behind Access, an allow-any-origin header
  would let any page the user visits ride their Access cookie into this API.
