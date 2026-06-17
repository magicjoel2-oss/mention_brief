# Wrapper invoked by Task Scheduler. Captures stdout+stderr to a per-day log
# file with UTF-8 (BOM) so Korean characters render correctly when viewed
# with Get-Content or Notepad.

$ErrorActionPreference = "Continue"

$workDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $workDir

if (-not (Test-Path "logs")) {
    New-Item -ItemType Directory -Path "logs" | Out-Null
}

$date = Get-Date -Format "yyyy-MM-dd"
$logFile = Join-Path $workDir "logs\digest-$date.log"

# Force UTF-8 in the current console so anything that does inherit the
# console encoding (rare on Windows, but safer) writes consistently.
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Run node, capture stdout+stderr, save as UTF-8.
& node "scripts\generate-digest.mjs" 2>&1 | Out-File -FilePath $logFile -Encoding utf8

exit $LASTEXITCODE
