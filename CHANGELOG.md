# Changelog

All notable changes to ClawSCAD. Versions follow [semver](https://semver.org/).

`scripts/release.ps1` pulls the release notes for a version straight out of the
matching `## [x.y.z]` section below, so keep the heading format exact.

## [0.7.4] - 2026-10-10

### Fixed

- **A failed build now says why.** When Claude Code stops without writing a
  model, the Studio shows its last line (for example "You've hit your session
  limit · resets 5:40pm") instead of only "The build exited 1".

## [0.7.3] - 2026-10-06

### Security

- **Dependency fixes for 29 open Dependabot alerts (17 high).** `electron` 43.2.0 to
  43.5.0 (three high Electron advisories), `js-yaml` 4.3.2 (used by the updater at
  runtime), `@xmldom/xmldom` 0.8.15, `fast-uri` 3.1.8, and `undici` 6.29.0 / 7.30.0 (the
  last two are build-time only). Brace-expansion and DOMPurify (npm copy) floors raised
  in the same pass. No application code changed.
- Still open: `braces` and `http-cache-semantics` (no upstream fix), and the DOMPurify
  copy that monaco inlines into the renderer bundle (3.2.7; no monaco release clears it).

## [0.7.2] - 2026-10-05

### Fixed

- **Make it is locked while a build runs.** The browser Studio now shows
  "Building…" and disables the button until the build ends, so the click that
  the server would refuse is never offered. A tab opened mid-build asks the
  server once and locks as well.

## [0.7.1] - 2026-10-05

### Fixed

- **"Couldn't reach the Claude Code terminal" no longer appears when Claude is fine.**
  In the browser Studio, clicking Make it while a build was still running got a
  `409 already-running` from the server, and the Studio reported it as an
  unreachable terminal. It now says what happened: a build is already running,
  how long ago it started, and to wait or stop it in the Workbench. A server that
  does not answer at all now says so, and suggests a reload in case the sign-in
  expired.

## [0.7.0] - 2026-09-02

### Added

- **The Workbench works in the browser now — on a phone as well as a laptop.**
  Opening a model from clawscad.dvlce.ca used to land on a panel explaining why
  it could not be done. It can be done: the model turns in 3D under your finger,
  the model list is there, the source is readable, and 3MF, STL and PNG download
  straight from it. The mesh is built on the machine hosting the site, by the
  same OpenSCAD the desktop app uses, and a model that already has a 3MF beside
  it is served as that — which is what makes a 100 MB model openable on a phone
  at all. Over 40 MB on a phone it shows a picture first and asks before loading
  the real thing.
- **Ask Claude, in the Workbench.** There is no terminal in a browser and there
  should not be one — it would be a shell on the studio machine behind a single
  login. Instead, describe the change, and Claude Code runs headless on the
  server with its log streaming into the pane; the model it writes opens right
  there when it finishes.

### Fixed

- **No more black console window sitting on the desktop.** The Studio web server
  runs as a scheduled task in your logged-in session, so Windows gave node.exe a
  console window that stayed open the whole time the site was up — and nothing in
  Task Scheduler can hide it. The task now starts through
  `scripts/studio-web-hidden.vbs`, which launches node with a hidden window and
  waits on it, so restart-on-failure still works exactly as before.
- **The app no longer flashes command windows while it works.** Every helper the
  app shells out to — the OpenSCAD binary, the generation CLI, the MCP server
  behind `npx` — was spawned with Windows' default of a visible console. They all
  pass `windowsHide` now.

## [0.6.4] - 2026-09-02

### Fixed

- **The site stopped 502ing when the wired network card dropped out.** The
  tunnel reached this machine at its wired address, and that card is a gigabit
  card negotiating 100 Mbps — a failing cable or port. Every time it blinked the
  site went down with "no route to host" even though the app itself was running
  perfectly. The tunnel now reaches the app over Tailscale, which does not care
  which network card is up.

### Added

- **A watchdog that notices when the app stops answering and restarts it.**
  Task Scheduler restarted the server when it crashed, but gave up permanently
  after three tries, and could never see the case where the process is alive but
  no longer serving — both of which look like a 502 to you while the task shows
  green. `scripts/studio-web-watchdog.ps1` probes the origin every 5 minutes and
  restarts it if three probes in a row fail. It takes three because a generation
  holds the machine for ~10 minutes, and a restart would kill that run with it.

## [0.6.3] - 2026-09-01

### Fixed

- **Work you made outside the desktop app now shows up in the browser.** A model
  finished by the pipeline — which is what every "make this into a 3D model" run
  now produces — wrote its file and then appeared nowhere: the recent list is
  built from a registry only the desktop app writes. Your finished models were
  on disk the whole time, with their printable files beside them, and the
  browser listed nothing. It now shows what actually exists.
- **The preview stopped appearing after you generated pictures.** Once a
  generation had run, every rendered preview in Customize silently failed to
  load for the rest of the day — the panel said "Rendered" and showed an empty
  box. The preview and the pictures are now both readable, and nothing else in
  the workspace became readable along with them.

## [0.6.2] - 2026-08-31

### Fixed

- **A closed tab no longer strands a finished mesh (web port).** Turning a
  picture into a 3D model runs three stages — mesh, prep, checkpoint — and until
  now the *browser* was what started each one after the last. Close the tab (or
  lose the connection) during the ten-minute mesh and the run simply stopped:
  the mesh finished, sat on disk, and never became a checkpoint, with nothing on
  screen to say why. It looked exactly like nothing had happened. The server now
  runs the whole chain itself and finishes it whether or not anyone is still
  watching.
- **Re-opening the page mid-run shows the run.** A tab that opens while a
  generation is in flight now says so and keeps its controls locked, instead of
  looking idle and answering the next click with "already running".
- A stage that fails, or a run you cancel, stops the whole chain — prep no
  longer runs against a mesh that was never written, which used to bury the real
  error under a second, worse one.

## [0.6.1] - 2026-08-30

### Added

- **"Make it" works in the browser.** Describing a part in a sentence now
  produces a real `.scad` from the web port, not a "not supported here" notice —
  Claude runs headless on the host and the file it wrote is found by looking at
  the workspace, not by taking the model's word for it.
- **Customize and export, in the browser.** Any model's parameters appear as
  knobs, and the preview you see is rendered by the same OpenSCAD that produces
  the download, so it cannot drift from what you get. **3MF** is the primary
  export (STL secondary), measured in real millimetres.
- **Self-hosting.** The Studio can run as a server behind Cloudflare Access —
  `web/README.md` has the whole story.

### Fixed

- Customize showed **zero parameters for every model** in a production install:
  the parameter parser loaded under a newer `node` but not under the one the
  service actually runs. It failed silently, which is the worst way for it to
  fail.

## [0.6.0] - 2026-08-29

### Added

- **Studio — a new front door.** The window now has two views, switched from the
  header: **Make** and **Workbench**. Make is a full-window dashboard — pick what
  you're making, describe it in a sentence, press one button. Previously that
  same flow lived in a 280 px scrolling rail wedged above the terminal, with the
  submit button below the fold.
- **Tools.** Thirteen switchable field groups — Dimensions, Hardware, Fit &
  tolerance, Mounting, The part it replaces, Text & engraving, Strength,
  Material, Print settings, Quantity, Style, Colour, Mesh detail — for saying
  what a sentence can't carry. Picking a print type switches on the ones that
  type usually needs; you can add or remove any of them. Each compiles into
  three separate things: constraints Claude reads, words the image prompt gets,
  and `claw-gen` flags. A tool that doesn't apply to what you're making says so
  in plain words instead of greying out.
- **A toggleable pre-image step.** *Pictures first* has three states — automatic
  (the app decides, and tells you why), always, and never. When it's on you get
  reference images before any mesh work, and you narrow in: **More like this**
  adds a round, **Refine…** adds a round with a change ("bigger eyes"), and
  earlier rounds stay on screen so you can compare. Approving a picture either
  meshes it or hands it to Claude as a reference to build parametrically,
  depending on what you're making.
- **Add a picture.** Attach an image as a **reference** for Claude, or
  **recreate** it directly as a 3D model. Recreating runs
  `claw-gen mesh --image … --new-job` and carries on through prep to a
  checkpoint.
- Per-backend availability. If image generation or 3D meshing is unavailable,
  the studio says so up front with the reason, and keeps every flow that still
  works — rather than failing ten minutes into a job.

### Fixed

- **`composer-state.json` was overwritten wholesale on every write.** With a
  second writer added this release, the composer's per-keystroke save would have
  deleted the studio's state moments after it was written. It now merges by
  top-level key. (An empty object still clears the file.)
- **Refine silently did nothing** (`clawscad-gen` 0.3.0). A new round on an
  existing job reused the job's cached expanded prompt, so a refinement was
  accepted, took a full round to run, and produced the same thing.
- **Every "More like this" started a new job**, whose candidate keys collide
  with the previous job's. Rounds now accumulate in one job.
- **An uploaded image was meshed into whatever job was last in flight**, so it
  was checkpointed under that job's name with two subjects' files interleaved.
  `claw-gen mesh --image` now takes `--new-job`.

### Changed

- **The build no longer rebuilds native modules for Electron.** `node-pty` is
  N-API, whose ABI is stable across Node and Electron, so the `electron-rebuild`
  postinstall was doing nothing but failing — it needed the Spectre-mitigated
  MSVC libraries, which is what blocked `npm run release` on Windows. A new
  `scripts/check-native-deps.js` fails the test run if a native dependency is
  ever added that is *not* N-API, since that one would silently package a binary
  that throws only in the installed app.
- **CI no longer publishes releases.** The three build workflows triggered on
  version tags and uploaded their own installer over the one `npm run release`
  had just published — a different binary, so its hash no longer matched the
  update manifest, permanently breaking that update for every client while the
  release script still printed green. `scripts/release.ps1` now owns the feed
  alone; CI builds on `main` and PRs for verification only.

## [0.5.1] - 2026-08-26

### Added

- **Auto-update.** ClawSCAD now checks its own GitHub releases, downloads a newer
  version in the background, and installs it when you quit — so a long Claude
  session or an in-flight render is never interrupted. A staged update shows as a
  pill in the status bar; clicking it restarts into the new version immediately.
  Checking and downloading stay silent by design.
- `npm run release` — a two-phase publish script that builds with
  `--publish never`, asserts the installer, blockmap and `latest.yml` are all
  present and mutually consistent, uploads them with `gh`, then reads the
  published manifest back over HTTP. This avoids an `electron-builder` race that
  can ship a public release with no update manifest at all.

### Notes

- The build already installed on your machine has no updater, so **one final
  manual install is unavoidable**. Every version after 0.5.1 updates itself.
