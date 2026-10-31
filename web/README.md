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
| **Workbench** | **Yes — browser-native** (v0.7.0). Not a port of `renderer.js`: `web/workbench.js` is its own build on the same three.js scene, with the checkpoint list, a read-only source view, per-checkpoint 3MF/STL/PNG export, and an **Ask Claude** pane in place of the pty terminal. Meshes come from the server (`/api/checkpoint/mesh`): a sibling `.3mf`/`.stl` if the desktop app already wrote one, otherwise an OpenSCAD render, deduped per file so two tabs share one run. Works on a phone — one column under 820 px, 44 px targets on a coarse pointer, one-finger orbit / two-finger pinch. |
| **The terminal** | **No, by design.** A live Claude Code session over `node-pty` is an interactive shell on the studio machine behind a single Access policy. Ask Claude runs `claude -p` headless and streams its log into the pane instead — Flow A's own mechanism, not a stub. |
| **Opening a checkpoint** | **Yes** (v0.7.0). Copies the checkpoint's `.scad` over `active.scad`, which is the file `CLAUDE.md` points Claude at — the **only** thing this port writes into the workspace besides uploads and renders. `clawscad.json` is still read-only here, so rename, delete and branch are not offered (and are not greyed-out either). The list is **reconciled in memory** (v0.6.3) — see the note below. |
| **Find & Print** | **Search, details, download, Open in ClawSCAD: yes** (v0.8). The same `main/finder/` code the desktop app runs. It queries Printables (the only live source; Thingiverse, MyMiniFactory and Cults3D are stubs that say "needs API key"; MakerWorld is not connected) at one request per second, downloads ONE STL/3MF per click from Printables into `<workspace>/models/`, and writes a mesh-derived checkpoint. `/api/model/file` and `/api/model/download` refuse `models/`, so downloads are never served back. **Print: no.** A browser tab has no route to the printer, so every `/api/finder/print*` route answers 403 `desktop-only` and the button says so. The `/api/finder/*` routes are the backend a phone app can call too. The tab, its view root and its stylesheet link are built by `renderer/finder.js` at mount (`web/index.html` is not edited), so a server that still runs an older bundle never shows a dead tab. |
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

## Find & Print API routes

These routes back the web interface and the Dvlce3D Explore tab.
All endpoints return JSON responses. Errors do not throw; they return `{ ok: false, error: { code, message } }`.

### `GET /api/finder/capabilities`
Returns the operational state of search sources and printer integration.
- **Parameters**: None.
- **Response** (200):
  ```json
  {
    "ok": true,
    "sources": {
      "printables": { "ready": true, "keyRequired": false, "reason": null },
      "thingiverse": { "ready": false, "keyRequired": true, "reason": "needs an API key" },
      "myminifactory": { "ready": false, "keyRequired": true, "reason": "needs an API key" },
      "cults3d": { "ready": false, "keyRequired": true, "reason": "needs an API key" }
    },
    "printing": false
  }
  ```
- **Notes**: In the web build, `printing` is always `false`.

### `GET /api/finder/search?q={query}&sites={sites}&page={page}&limit={limit}`
Searches 3D models across enabled sources.
- **Query parameters**:
  - `q` (required, string): Search query text (trimmed, up to 200 characters). Returns 400 if empty.
  - `sites` (optional, string): Comma-separated list of sources (e.g. `printables`). Default is `printables`.
  - `page` (optional, integer): Zero-based page offset (default: `0`).
  - `limit` (optional, integer): Results per page (default: `24`).
- **Response** (200):
  ```json
  {
    "ok": true,
    "query": "gridfinity",
    "page": 0,
    "limit": 24,
    "items": [
      {
        "id": "1685835",
        "site": "printables",
        "title": "Gridfinity Box",
        "author": "Designer",
        "description": "Plain text summary",
        "url": "https://www.printables.com/model/1685835-...",
        "coverUrl": "https://media.printables.com/...",
        "downloadCount": 120,
        "likeCount": 45,
        "fileFormats": ["stl"],
        "licence": {
          "code": "CC-BY-4.0",
          "name": "Creative Commons Attribution 4.0",
          "url": "https://creativecommons.org/licenses/by/4.0/",
          "summary": "You can share and adapt with credit."
        }
      }
    ],
    "sites": {
      "printables": {
        "status": "ok",
        "count": 1,
        "total": 1,
        "cached": false,
        "stale": false,
        "ageMs": 0,
        "error": null
      }
    }
  }
  ```
- **Error Responses**:
  - 400 `{ ok: false, error: { code: "empty-query", message: "Enter a search term." } }`

### `GET /api/finder/detail?site={site}&id={id}`
Fetches full model metadata, images, and downloadable file entries.
- **Query parameters**:
  - `site` (required, string): Target source site (e.g. `printables`).
  - `id` (required, string): Model identifier.
- **Response** (200):
  ```json
  {
    "ok": true,
    "detail": {
      "id": "1685835",
      "site": "printables",
      "title": "Gridfinity Box",
      "author": "Designer",
      "description": "Full description text",
      "url": "https://www.printables.com/model/1685835-...",
      "coverUrl": "https://media.printables.com/...",
      "images": ["https://media.printables.com/..."],
      "files": [
        {
          "id": "9901",
          "name": "box.stl",
          "size": 1048576,
          "format": "stl",
          "url": "https://media.printables.com/..."
        }
      ],
      "licence": {
        "code": "CC-BY-4.0",
        "name": "Creative Commons Attribution 4.0",
        "url": "https://creativecommons.org/licenses/by/4.0/",
        "summary": "You can share and adapt with credit."
      }
    }
  }
  ```
- **Error Responses**:
  - 404 `{ ok: false, error: { code: "not-found", message: "Model not found." } }`
  - 502 `{ ok: false, error: { code: "upstream-error", message: "..." } }`

### `POST /api/finder/download`
Downloads one selected model file into `<workspace>/models/<site>-<id>/`. Writes provenance metadata into `<workspace>/models/<site>-<id>/source.json`.
- **Headers**: `Content-Type: application/json`
- **Body**:
  ```json
  {
    "site": "printables",
    "id": "1685835",
    "fileId": "9901"
  }
  ```
- **Response** (200):
  ```json
  {
    "ok": true,
    "file": {
      "path": "models/printables-1685835/box.stl",
      "name": "box.stl",
      "size": 1048576,
      "format": "stl",
      "site": "printables",
      "id": "1685835",
      "fileId": "9901"
    }
  }
  ```
- **Notes**: Files under `<workspace>/models/` are protected. They are not served by `/api/model/file` or `/api/model/download`.

### `POST /api/finder/open`
Prepares a downloaded model for CAD editing in ClawSCAD:
1. Copies the file to `<workspace>/meshes/<slug>.stl` (converts 3MF to binary STL if needed).
2. Generates a new OpenSCAD checkpoint `.scad` that imports the mesh.
- **Headers**: `Content-Type: application/json`
- **Body**:
  ```json
  {
    "site": "printables",
    "id": "1685835",
    "path": "models/printables-1685835/box.stl"
  }
  ```
- **Response** (200):
  ```json
  {
    "ok": true,
    "scadPath": "printables-1685835-box.scad",
    "meshPath": "meshes/printables-1685835-box.stl",
    "checkpointId": null
  }
  ```

### `GET` / `POST /api/finder/print*`
Printer routes require the desktop environment.
- **Response** (403):
  ```json
  {
    "ok": false,
    "error": {
      "code": "desktop-only",
      "message": "Printing needs the desktop app: the web build cannot reach the printer on your network."
    }
  }
  ```
