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
| **Flow C — recreate an upload** | Fully, for images. `mesh --image <relPath> --new-job` runs and chains mesh → prep → checkpoint. |
| **Upload** | Images only (png, jpg, webp, svg, dxf). `upload:pick` has no browser equivalent, so the shim drives a hidden `<input type=file>`; drag-and-drop goes through `upload:ingest-bytes`. Files land in `<workspace>/uploads/` via `main/uploads.js`'s own `storeUnique` (hash on collision, never overwrite) and are recorded in `uploads/uploads.json`. |
| **Flow A — "Make it" straight to Claude** | **No.** There is no pty in a browser. `/api/composer/send-to-claude` answers `501` with a stated reason, the shim resolves `false`, and the Studio raises its own notice. It is never faked. |
| **Workbench** | **No.** The three.js viewport, the `node-pty` terminal, the OpenSCAD render and the checkpoint tree are all absent. The Workbench tab leads to a panel naming each one. |
| **Opening a checkpoint** | **No.** `clawscad.json` is read (so "pick up where you left off" lists real work) but never written, and selecting one explains that it needs the desktop app. |
| **Locate claw-gen…** | **No.** A browser cannot browse the server's filesystem, and exposing a remote file picker behind a tunnel would be a bad idea. Set `CLAWSCAD_CLI` instead. |
| **Editing / exporting / rendering** | **No.** Those are workbench features. |

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
- **The `#gen-*` elements in `index.html` are off-screen, not inert.** `studio.js`
  writes `#gen-prompt`, clicks `#gen-generate-btn`, clicks a
  `.gen-candidate[data-key]`, then clicks `#gen-make3d-btn`, and it reads
  `#gen-generate-btn.disabled` through a `MutationObserver` as its *only*
  end-of-run signal. `entry.js` owns their behaviour exactly as `renderer.js`
  does on the desktop. Remove one and the picture step goes silently dead. Add
  `debug-gen` to `<body>` to see the panel.
- **Path handling is the security boundary.** `containedInWorkspace()` resolves
  and `realpath`s both ends and compares with `path.relative` — it does not
  filter `..`, because an absolute path on another drive and a symlink out of
  the tree both contain none.
- **No CORS headers, deliberately.** Behind Access, an allow-any-origin header
  would let any page the user visits ride their Access cookie into this API.
