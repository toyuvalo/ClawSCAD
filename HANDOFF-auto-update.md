# Handoff — auto-update for ClawSCAD

Branch: `feat/auto-update`. Nothing has been published, no release exists, no tag
was pushed. This branch is ready for you to review and merge.

## Why

Without an updater the installed binary silently rots. Cadence's installed `.exe`
sat five versions behind for a month; the person using it only found out when a
feature they'd asked for that morning wasn't in the app they opened, and the
first suspicion was a stale shortcut. Any app installed on a real machine gets
auto-update in its first release, not later.

The pattern here is the fleet standard —
`E:\Claude\wiki\references\electron-auto-update.md` is the spec, and
`E:\cadence` is the reference implementation.

## What changed

| File | Change |
|---|---|
| `main/updater.js` | **New.** The whole updater. Lazy `require('electron-updater')` in a try/catch, `app.isPackaged` guard, background download, install-on-quit, error classification. |
| `main.js` | Requires the updater and registers its IPC at module load; starts it in `whenReady`. Adds `broadcastAll()` next to `ctxSend()` so status reaches every window, not just one. |
| `preload.js` | Exposes `getUpdateStatus` / `checkUpdates` / `installUpdate` / `onUpdateStatus` on `window.api`. All payload-free in the renderer→main direction. |
| `index.html` | One `<button id="update-pill">` in the status bar, next to the version. |
| `renderer.js` | Shows that pill **only** when an update is staged; clicking it restarts into the new version. |
| `style.css` | `.update-pill` styling. |
| `package.json` | `electron-updater` as a **dependency**; `build.publish` → `toyuvalo/ClawSCAD`; **`win.artifactName` pinned**; `nsis.perMachine: false`; `release` / `release:dry` scripts. |
| `CHANGELOG.md` | **New.** `scripts/release.ps1` reads release notes out of it. |
| `scripts/release.ps1` | **New.** The safe two-phase publish (see below). |

### Design decisions worth knowing

- **Install on quit, never mid-session.** `autoInstallOnAppQuit = true`. Restarting
  the editor under someone mid-render or mid-Claude-session is worse than being
  a version behind.
- **Only a *staged* update is announced.** Checking, downloading and failed
  checks stay silent. A notification you can't act on is noise.
- **First check is delayed 25 s** so it never competes with OpenSCAD probing,
  pty spawn and MCP warm-up. Then every 6 hours. Both timers are `unref`'d.
- **The version is not re-declared anywhere.** `main.js` already read it from
  `package.json`; the release script reads the same file. Nothing to drift.

## How to cut the first release

```powershell
npm run release            # build, assert, publish, verify
npm run release:dry        # build + assert only — publishes nothing
```

`gh` must be authenticated with push access to `toyuvalo/ClawSCAD`. No token is
needed by the app itself — a public repo needs no credentials on the client side.

**Do not use `electron-builder --publish always`.** It has a race that
silently ships a release with no `latest.yml`, which makes that release
invisible to every updater client, forever. It has done this to Cadence four
times. Full forensics: `E:\Claude\agent-output\cadence-publish-422.md`. The
script exists specifically to avoid that: it builds with `--publish never`,
asserts the `.exe` + `.blockmap` + `latest.yml` all exist and describe the same
build (matching version, matching path, matching sha512), uploads with `gh` one
file at a time, and then **fetches the published `latest.yml` back over HTTP** to
prove the feed actually works before it says it succeeded.

## The one-time manual install

**The version currently installed on any machine has no updater in it, so it
cannot update itself.** Whoever runs `npm run release` must also install that
first build by hand, once, from the GitHub release page. Every version after
that arrives automatically. There is no way around this for any app; it is a
one-time cost per machine.

## Verified / not verified

Verified:

- `node --check` clean on `main.js`, `preload.js`, `main/updater.js`, `renderer.js`.
- `npm run build:renderer` succeeds.
- `npm audit --omit=dev` → **0 vulnerabilities**.
- **A real Windows NSIS build completed** and produced
  `release/ClawSCAD-Setup-0.5.1.exe`, its `.blockmap`, and `latest.yml`.
- `latest.yml` names `ClawSCAD-Setup-0.5.1.exe` — hyphens, no spaces —
  matching the pinned `artifactName`. This is the mismatch that would otherwise
  404 the updater forever, and it is now correct.
- `scripts/release.ps1 -SkipBuild -DryRun` passes every assertion against those
  real artifacts (version, path, and sha512 all match).
- The builder reports `oneClick=false perMachine=false`, so applying an update
  never prompts for admin.

Not verified:

- **Nothing was published.** The `gh` upload and the post-publish read-back
  (steps 3 and 4 of the script) have never run. They are ported unchanged from
  Cadence's script, where they do work.
- **The updater has not been observed finding a real update**, because no
  release exists yet. The first `npm run release` is also the first end-to-end
  test of the feed.
- **The UI pill has not been seen on screen** — it only renders for a staged
  update, which requires a published newer release.

## Two toolchain problems on this machine (pre-existing, not from this branch)

`npm install` and `electron-builder` both fail while rebuilding `node-pty`:

1. `NoDefaultCurrentDirectoryInExePath=1` is set in this environment, which
   makes winpty's gyp step fail with `'GetCommitHash.bat' is not recognized`.
   Clearing that variable for the build fixes it.
2. With that cleared, MSBuild then fails `MSB8040: Spectre-mitigated libraries
   are required`. Fix by installing the Spectre-mitigated MSVC libraries from
   the Visual Studio Installer (Individual Components), for the v143 x64
   toolset.

The build above was therefore run with `-c.npmRebuild=false` — legitimate here
because `node-pty` ships `win32-x64` prebuilds and those are what actually got
packaged. **Until (2) is fixed, `npm run release` will fail at the build step on
this machine.** Nothing about that is caused by this branch, but it does stand
between you and the first release.

## Decisions still yours

1. **Version number.** The repo's auto-commit hook bumped this to `0.5.1` while
   the branch was being written (the task called for a minor bump from `0.4.0`,
   i.e. `0.5.0`). `CHANGELOG.md` has been re-synced to `0.5.1`. If that hook
   fires again the heading will drift — re-sync it before releasing, or the
   release notes will fall back to a bare placeholder.
2. **Install the Spectre libs, or set `npmRebuild: false` in the build config?**
   The latter is a one-line change and is arguably correct given `node-pty`
   ships prebuilds, but it would also silence a genuine warning for any *future*
   native dependency. I did not make that change — it's a standing policy call,
   not part of wiring an updater.
3. `release/ClawSCAD-Setup-0.5.1.exe` (154 MB) and `vendors/` (65 MB of
   OpenSCAD) were left on disk from the verification build. Both are gitignored;
   delete them if you want a clean tree.
