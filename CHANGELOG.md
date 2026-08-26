# Changelog

All notable changes to ClawSCAD. Versions follow [semver](https://semver.org/).

`scripts/release.ps1` pulls the release notes for a version straight out of the
matching `## [x.y.z]` section below, so keep the heading format exact.

## [0.5.0] - 2026-08-26

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
  manual install is unavoidable**. Every version after 0.5.0 updates itself.
