<#
.SYNOPSIS
  Build and publish a gemscad release — safely.

.DESCRIPTION
  Deliberately does NOT use `electron-builder --publish always`, which has a race
  that can put an INCOMPLETE release on GitHub:

    electron-builder creates one publisher per artifact (the .exe and its
    .blockmap). Both check "does this release exist?", both get "no", and both
    POST /releases ~25ms apart. GitHub creates one and rejects the other with
    422 "Published releases must have a valid tag". That rejection throws inside
    PublishManager.awaitTasks() BEFORE writeUpdateInfoFiles() runs — and that is
    the only place latest.yml is written. Result: a public release with an
    installer and no update manifest, which every electron-updater client is
    blind to. It is silent by construction, and it has bitten Cadence four times.
    Full forensics: E:\Claude\agent-output\cadence-publish-422.md

  This script decouples the two phases, which removes the whole class of failure:

    1. BUILD with --publish never. latest.yml is still generated (its creation is
       not gated on publishing) but nothing is uploaded, so no race can occur.
    2. ASSERT every artifact exists and is self-consistent BEFORE anything
       becomes public.
    3. PUBLISH with `gh`, one sequential upload at a time.
    4. VERIFY the manifest is actually fetchable from the release and names this
       version — the check that catches a partial publish while it can still be
       fixed.

  Requires: `gh` authenticated with push access to toyuvalo/gemscad.

.EXAMPLE
  npm run release
  npm run release:dry                                  # build + assert, publish nothing
  pwsh scripts/release.ps1 -PreRelease -Tag v0.6.0-beta.1
  pwsh scripts/release.ps1 -SkipBuild                  # re-publish an already-built release/
#>
[CmdletBinding()]
param(
  [string]$Tag,
  [switch]$PreRelease,
  [switch]$SkipBuild,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Step($msg) { Write-Host "`n=== $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Die($msg)  { Write-Host "  FAIL  $msg" -ForegroundColor Red; exit 1 }

# --- version -----------------------------------------------------------------
# package.json is the single source of truth; main.js reads its version from the
# same file, so the two can never drift.
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$version = $pkg.version
if (-not $Tag) { $Tag = "v$version" }
$exeName = "gemscad-Setup-$version.exe"
$releaseDir = Join-Path $repoRoot 'release'
Step "gemscad $version  ->  tag $Tag"

# --- 1. build ----------------------------------------------------------------
if ($SkipBuild) {
  Write-Host "  (skipping build)"
} else {
  Step 'Building (--publish never: manifest is produced, nothing is uploaded)'
  # Stale artifacts from an older version would otherwise sail through the
  # assertions below and get published.
  if (Test-Path $releaseDir) {
    Get-ChildItem $releaseDir -Filter '*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force
    Get-ChildItem $releaseDir -Filter '*.blockmap' -ErrorAction SilentlyContinue | Remove-Item -Force
    Remove-Item (Join-Path $releaseDir 'latest.yml') -Force -ErrorAction SilentlyContinue
  }

  # OpenSCAD is bundled via extraResources and the renderer is an esbuild
  # bundle — both must exist before electron-builder packs anything.
  & npm run download-openscad
  if ($LASTEXITCODE -ne 0) { Die "download-openscad exited $LASTEXITCODE" }
  & npm run build:renderer
  if ($LASTEXITCODE -ne 0) { Die "build:renderer exited $LASTEXITCODE" }

  & npx electron-builder --win --publish never
  if ($LASTEXITCODE -ne 0) { Die "electron-builder exited $LASTEXITCODE" }
}

# --- 2. assert ---------------------------------------------------------------
Step 'Verifying artifacts before anything becomes public'

$exe  = Join-Path $releaseDir $exeName
$bmap = Join-Path $releaseDir "$exeName.blockmap"
$yml  = Join-Path $releaseDir 'latest.yml'

foreach ($f in @($exe, $bmap, $yml)) {
  if (-not (Test-Path $f)) { Die "missing artifact: $f" }
  Ok "exists: $(Split-Path $f -Leaf) ($([math]::Round((Get-Item $f).Length/1MB,1)) MB)"
}

# latest.yml must describe THIS build, or clients get pointed at the wrong file.
$ymlText = Get-Content $yml -Raw
$ymlVersion = ([regex]::Match($ymlText, '(?m)^version:\s*(.+)$')).Groups[1].Value.Trim()
$ymlPath    = ([regex]::Match($ymlText, '(?m)^path:\s*(.+)$')).Groups[1].Value.Trim()
$ymlSha     = ([regex]::Match($ymlText, '(?m)^sha512:\s*(.+)$')).Groups[1].Value.Trim()

if ($ymlVersion -ne $version) { Die "latest.yml says version $ymlVersion, package.json says $version" }
Ok "latest.yml version matches package.json ($version)"
# The classic 404-forever bug: electron-builder writes a hyphenated URL into the
# manifest but names the default output file with spaces. win.artifactName is
# pinned in package.json to keep these identical; this asserts it stayed that way.
if ($ymlPath -ne $exeName) { Die "latest.yml path is '$ymlPath', expected '$exeName'" }
Ok "latest.yml points at $exeName"

# The updater refuses a download whose hash doesn't match, so a stale manifest
# is a broken update rather than a wrong one. Catch it here instead.
$actualSha = [Convert]::ToBase64String([System.Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($exe)))
if ($actualSha -ne $ymlSha) { Die "sha512 mismatch: latest.yml does not describe this installer" }
Ok 'latest.yml sha512 matches the built installer'

if ($DryRun) { Write-Host "`nDry run - nothing published." -ForegroundColor Yellow; exit 0 }

# --- 2b. STOP: the publish target has not been decided ------------------------
# This repo's `origin` is levkropp/ClawSCAD, which is NOT ours to publish to, and
# the `fork` remote (toyuvalo/ClawSCAD) is the SAME GitHub repo the separate
# ClawSCAD app at E:\clawscad-app already publishes to. electron-updater picks the
# newest release in a repo regardless of which product it belongs to, so pointing
# gemscad at that fork would make the two apps offer each other's builds as
# updates.
#
# build.publish is therefore a PLACEHOLDER (toyuvalo/gemscad, which does not exist
# yet). Refusing here is deliberate: publishing to the wrong feed is not something
# you can quietly undo once a client has fetched it. Read HANDOFF-auto-update.md,
# pick a target, then delete this block.
Die @"
publish target not decided - refusing to publish.

  build.publish currently points at $($pkg.build.publish[0].owner)/$($pkg.build.publish[0].repo), which is a
  placeholder. See HANDOFF-auto-update.md for the three options and why
  reusing toyuvalo/ClawSCAD would cross-feed two different apps' updaters.

  Everything up to this point (build + artifact assertions) has already run
  and passed, so nothing else is blocking a release once the target is set.
"@


# --- 3. publish --------------------------------------------------------------
Step "Publishing $Tag to GitHub"

# Release notes: this version's CHANGELOG section only, not the whole file.
$notesFile = Join-Path ([IO.Path]::GetTempPath()) "clawscad-notes-$version.md"
if (Test-Path 'CHANGELOG.md') {
  $changelog = Get-Content 'CHANGELOG.md' -Raw
  $section = [regex]::Match($changelog, "(?ms)^##\s*\[$([regex]::Escape($version))\].*?(?=^##\s*\[|\z)")
} else {
  $section = $null
}
if ($section -and $section.Success) {
  ($section.Value.Trim()) | Set-Content $notesFile -Encoding UTF8
  Ok 'release notes extracted from CHANGELOG.md'
} else {
  "gemscad $version" | Set-Content $notesFile -Encoding UTF8
  Write-Host "  note: no CHANGELOG section for $version; using a placeholder" -ForegroundColor Yellow
}

$exists = (& gh release view $Tag --json tagName 2>$null)
if ($LASTEXITCODE -eq 0 -and $exists) {
  Write-Host "  release $Tag already exists - uploading assets with --clobber"
  & gh release upload $Tag $exe $bmap $yml --clobber
  if ($LASTEXITCODE -ne 0) { Die 'gh release upload failed' }
} else {
  # NB: not $args — that is an automatic variable in PowerShell.
  $ghArgs = @('release','create',$Tag,'--title',$version,'--notes-file',$notesFile,$exe,$bmap,$yml)
  if ($PreRelease) { $ghArgs += '--prerelease' }
  & gh @ghArgs
  if ($LASTEXITCODE -ne 0) { Die 'gh release create failed' }
}
Ok 'assets uploaded'

# --- 4. verify the published feed -------------------------------------------
# The failure this script exists to prevent is silent, so never trust the upload
# without reading back what clients will actually fetch.
Step 'Verifying the published update feed'

$assets = (& gh release view $Tag --json assets --jq '[.assets[].name]' | ConvertFrom-Json)
foreach ($want in @($exeName, "$exeName.blockmap", 'latest.yml')) {
  if ($assets -notcontains $want) { Die "asset missing from the release: $want" }
  Ok "published: $want"
}

$base = "https://github.com/$($pkg.build.publish[0].owner)/$($pkg.build.publish[0].repo)/releases/download/$Tag"
try {
  $resp = Invoke-WebRequest "$base/latest.yml" -UseBasicParsing -TimeoutSec 30
  # GitHub serves release assets as application/octet-stream, so PowerShell
  # returns .Content as a byte[] rather than a string. Decode it explicitly, or
  # every regex below quietly matches nothing.
  $remoteYml = if ($resp.Content -is [byte[]]) {
    [System.Text.Encoding]::UTF8.GetString($resp.Content)
  } else {
    [string]$resp.Content
  }
} catch { Die "latest.yml is not fetchable from the release: $_" }

$remoteVersion = ([regex]::Match($remoteYml, '(?m)^version:\s*(.+)$')).Groups[1].Value.Trim()
if ($remoteVersion -ne $version) { Die "published latest.yml says $remoteVersion, expected $version" }
Ok "published latest.yml is reachable and reports $remoteVersion"

try {
  $head = Invoke-WebRequest "$base/$exeName" -Method Head -UseBasicParsing -TimeoutSec 30
  Ok "installer is downloadable (HTTP $($head.StatusCode))"
} catch { Die "installer is not downloadable: $_" }

Remove-Item $notesFile -Force -ErrorAction SilentlyContinue
Write-Host "`nReleased gemscad $version - existing installs will update themselves.`n" -ForegroundColor Green
