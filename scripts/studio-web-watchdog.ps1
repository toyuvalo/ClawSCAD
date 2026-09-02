# studio-web-watchdog.ps1 - keeps the ClawSCAD Studio web origin answering.
#
# Task Scheduler already restarts the task when node *exits*, but only 3 times,
# and it cannot see a process that is alive yet no longer serving. Both of those
# gaps end as a 502 at clawscad.dvlce.ca with the task showing green.
#
# Probes the origin the way cloudflared does. Restarts only after every probe in
# a run fails: a generation holds the box for ~10 minutes and a restart kills the
# server-side chain with it, so a single slow reply must never be enough.

[CmdletBinding()]
param(
  [int]    $Port         = 8730,
  [string] $TaskName     = 'ClawSCAD-Studio-Web',
  [int]    $Probes       = 3,
  [int]    $ProbeGapSec  = 15,
  [int]    $TimeoutSec   = 10,
  [string] $LogPath      = 'E:\clawscad-app\web-watchdog.log'
)

$ErrorActionPreference = 'Stop'

function Write-Log {
  param([string] $Message)
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try {
    Add-Content -Path $LogPath -Value $line -Encoding utf8
    # Keep the log from growing without bound; this runs every 5 minutes forever.
    $item = Get-Item -LiteralPath $LogPath -ErrorAction Stop
    if ($item.Length -gt 1MB) {
      $keep = Get-Content -LiteralPath $LogPath -Tail 500
      Set-Content -LiteralPath $LogPath -Value $keep -Encoding utf8
    }
  } catch { }
}

function Test-Origin {
  # /api/pipeline/status is a cheap read and, unlike /, is served even when the
  # workspace registry is mid-write.
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/pipeline/status" `
                           -TimeoutSec $TimeoutSec -UseBasicParsing
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
  } catch {
    return $false
  }
}

$healthy = $false
for ($i = 1; $i -le $Probes; $i++) {
  if (Test-Origin) { $healthy = $true; break }
  if ($i -lt $Probes) { Start-Sleep -Seconds $ProbeGapSec }
}

if ($healthy) { exit 0 }

Write-Log "UNHEALTHY: $Probes/$Probes probes failed on port $Port - restarting '$TaskName'"

try {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3

  # Stop-ScheduledTask does not always reap the child node.exe, and a survivor
  # holds the port so the fresh instance dies on EADDRINUSE.
  $stale = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $stale) {
    try {
      $p = Get-Process -Id $c.OwningProcess -ErrorAction Stop
      if ($p.ProcessName -eq 'node') {
        Write-Log "  killing stale node pid=$($p.Id) still holding $Port"
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      }
    } catch { }
  }
  Start-Sleep -Seconds 2

  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 8

  if (Test-Origin) {
    Write-Log '  RECOVERED: origin answering again'
    exit 0
  }
  Write-Log '  STILL DOWN after restart - needs a human'
  exit 1
} catch {
  Write-Log "  RESTART FAILED: $($_.Exception.Message)"
  exit 1
}
