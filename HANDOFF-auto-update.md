# Handoff — auto-update for gemscad

Branch: `feat/auto-update`, **local only**. Nothing has been pushed anywhere,
no release exists, no tag was created.

## ⚠ Read this before anything else: there is no publish target

This is the one repo in this rollout where the work is finished but **cannot be
released**, because it is not clear where it should release *to*. That decision
is yours, and it has to be made before the first `npm run release`.

Here is the actual situation:

| Remote | Points at | Can we publish there? |
|---|---|---|
| `origin` | `levkropp/ClawSCAD` | **No.** Not ours. |
| `fork` | `toyuvalo/ClawSCAD` | **Technically yes — but it's already taken.** |

That second row is the trap. `toyuvalo/ClawSCAD` is the **same GitHub repo** that
the separate ClawSCAD app at `E:\clawscad-app` now publishes its own releases to
(that branch is done and pushed). And `electron-updater`'s GitHub provider does
not filter by product — it takes **the newest Release in the repo** and reads
`latest.yml` from it.

So if gemscad published to that fork, the two apps would share one update feed:
a gemscad release would be offered to ClawSCAD users and vice versa, each
downloading an installer for a different application. That failure is silent from
the publisher's side and only shows up on someone else's machine.

`build.publish` is therefore set to a **placeholder**: `toyuvalo/gemscad`, a repo
that does not exist yet. And `scripts/release.ps1` **deliberately refuses to
publish** — it runs the whole build and every artifact assertion, then stops with
an explanation. Delete that block once you've picked a target.

### The options, as I see them

1. **A dedicated `toyuvalo/gemscad` repo.** Cleanest. Its own release feed, no
   interference with either ClawSCAD, and the placeholder already points there so
   nothing else needs changing. Costs one `gh repo create`.
2. **Upstream to `levkropp/ClawSCAD`.** Only viable if that's a collaboration you
   have publish rights on and lev wants gemscad releases in it. Not something I
   can or should decide.
3. **Don't distribute gemscad at all.** If this is a personal workspace fork you
   run from source, an updater is dead weight — drop this branch. That is a
   perfectly reasonable outcome and I'd rather flag it than have you inherit a
   release pipeline you didn't want.

Everything below assumes you pick (1).

## What changed

| File | Change |
|---|---|
| `main/updater.js` | **New.** The whole updater. Lazy `require('electron-updater')` in a try/catch, `app.isPackaged` guard, background download, install-on-quit, error classification. |
| `main.js` | Derives `APP_VERSION` from `package.json`; adds `broadcastAll()` next to `ctxSend()`; registers the updater's IPC at module load and starts it in `whenReady`. |
| `preload.js` | Exposes `getAppVersion` / `getUpdateStatus` / `checkUpdates` / `installUpdate` / `onUpdateStatus` on `window.api`. |
| `index.html` | A version label and an update pill in the status bar. |
| `renderer.js` | Fills the version, and shows the pill **only** when an update is staged. |
| `style.css` | `.app-version` and `.update-pill`. |
| `package.json` | Version `0.2.0`; `electron-updater` as a **dependency**; placeholder `build.publish`; **`win.artifactName` pinned**; `nsis.perMachine: false`; `release` / `release:dry` scripts; security overrides (below). |
| `scripts/release.ps1` | **New.** The safe two-phase publish, with the refuse-to-publish guard. |

### Design decisions

- **Install on quit, never mid-session.** Restarting the editor under someone
  mid-render or mid-Gemini-session is worse than being a version behind.
- **Only a *staged* update is announced.** Checking, downloading, and failed
  checks stay silent — a notification you can't act on is noise.
- **First check delayed 25 s**, then every 6 hours. Both timers `unref`'d, so an
  update check can never hold the process open.
- **The version is derived, never re-declared.** This repo had no version
  constant at all; `main.js` now does
  `const APP_VERSION = require('./package.json').version`. Please don't
  reintroduce a literal — that drift has bitten three other apps in this fleet.

### Why `artifactName` is pinned

`electron-builder` writes a **hyphenated** URL into `latest.yml` but names the
default output file after `productName`. When those disagree, the updater fetches
a filename that doesn't exist and 404s **forever**, silently. Pinning
`win.artifactName` to `gemscad-Setup-${version}.${ext}` keeps them identical, and
`release.ps1` asserts the manifest's `path` matches before publishing anything.

## How to cut the first release (once you've picked a target)

```powershell
npm run release:dry     # build + assert only — safe to run today
npm run release         # will REFUSE until you remove the guard in the script
```

**Do not use `electron-builder --publish always`.** It has a race that silently
ships a release with no `latest.yml`, making it invisible to every updater
client, forever — it has done this to Cadence four times. Forensics:
`E:\Claude\agent-output\cadence-publish-422.md`. The script builds with
`--publish never`, asserts the `.exe` + `.blockmap` + `latest.yml` all describe
the same build (version, path, sha512), uploads with `gh` one file at a time,
then **fetches the published `latest.yml` back over HTTP** before declaring
success.

Note the `.github/workflows/build-*.yml` in this repo already build on tag push
and attach `release/*.exe` via `softprops/action-gh-release`. **Those workflows
upload the `.exe` only — no `.blockmap`, no `latest.yml`** — so a release cut by
CI would be invisible to the updater. If you go with option (1) you'll need to
either extend those workflows to upload all three artifacts, or release from your
machine with `npm run release` and stop tagging for CI releases. Two publish
paths for one app is how feeds get half-populated.

## The one-time manual install

**Any gemscad already installed has no updater in it and cannot update itself.**
The first release has to be installed by hand, once, per machine. Everything
after that is automatic.

## Security overrides added

`npm audit --omit=dev` reported **4 production vulnerabilities** here (2 high, 2
moderate). One of them, `js-yaml`, arrives through `electron-updater` — i.e. this
branch introduced it, so it's mine to fix. The other two packages (`dompurify`
via `monaco-editor`, `picomatch` via `chokidar`) were **already** vulnerable
before this branch.

I fixed all of them using the exact override set the sibling app at
`E:\clawscad-app` already runs with (same codebase lineage, proven clean):

```json
"overrides": {
  "js-yaml": "^4.3.1",
  "dompurify": "^3.4.13",
  "anymatch":   { "picomatch": "^2.3.2" },
  "readdirp":   { "picomatch": "^2.3.2" },
  "tinyglobby": { "picomatch": "^4.0.4" }
}
```

`npm audit --omit=dev` now reports **0 vulnerabilities**. Flagging it because two
of those three were pre-existing and fixing them was slightly beyond "add an
updater" — revert them if you'd rather handle them separately.

## Verified / not verified

Verified:

- `node --check` clean on `main.js`, `preload.js`, `main/updater.js`,
  `renderer.js`.
- `npm run build:renderer` succeeds.
- `npm audit --omit=dev` → **0 vulnerabilities** (was 4).
- `scripts/release.ps1` parses cleanly under the PowerShell parser.
- **A real Windows NSIS build completed** — `release/gemscad-Setup-0.2.0.exe`
  plus its `.blockmap` and `latest.yml`. `latest.yml` names
  `gemscad-Setup-0.2.0.exe`, matching the pinned `artifactName`.
- `scripts/release.ps1 -SkipBuild -DryRun` passes every assertion against those
  real artifacts (version, path and sha512 all match).
- Builder reports `perMachine=false`, so applying an update never prompts for
  admin.

Not verified:

- **Nothing was published, and nothing was pushed.** This branch exists only on
  this machine.
- **The updater has never found a real update** — there is no release feed to
  find one in, by design.
- **The version label and update pill have not been seen on screen.** The pill
  only renders for a staged update, which needs a published newer release.
- The Linux and macOS targets were not touched.

## Toolchain problems on this machine (pre-existing)

`npm install` runs `electron-rebuild -f -w node-pty` as a `postinstall`, and it
fails here for two separate reasons:

1. `NoDefaultCurrentDirectoryInExePath=1` is set in this environment, which makes
   winpty's gyp step fail with `'GetCommitHash.bat' is not recognized`. Clearing
   that variable for the build fixes it.
2. With that cleared, MSBuild then fails `MSB8040: Spectre-mitigated libraries
   are required`. Fix by installing the Spectre-mitigated MSVC libraries from the
   Visual Studio Installer (Individual Components) for the v143 x64 toolset.

Dependencies here were installed with `--ignore-scripts` to sidestep that, which
is safe because `node-pty` ships `win32-x64` prebuilds and those are what get
packaged anyway. **Until (2) is fixed, `npm run release` cannot complete its
build step on this machine.** Nothing to do with this branch.

## Decisions still yours

1. **Where does gemscad publish?** The whole point of this document. See the
   three options above.
2. **CI or local releases, not both.** See the workflow note above.
3. **Keep the security overrides, or handle those separately?**
4. Whether gemscad should be distributed at all.
