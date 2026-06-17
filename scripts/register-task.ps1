# =============================================================================
# Register Windows Scheduled Task: MentionBriefDaily
# Runs every day at 09:00 (local time = KST on this PC).
#
# Run once, after a clean `npm run digest` works manually:
#   PS> cd C:\AiApps\mention_brief
#   PS> .\scripts\register-task.ps1
#
# To inspect / test:
#   Get-ScheduledTask MentionBriefDaily | Get-ScheduledTaskInfo
#   Start-ScheduledTask -TaskName MentionBriefDaily      # fire now
#   Get-Content logs\digest-*.log -Tail 30
#
# To unregister:
#   Unregister-ScheduledTask -TaskName MentionBriefDaily -Confirm:$false
# =============================================================================

$ErrorActionPreference = "Stop"

$taskName = "MentionBriefDaily"
$workDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$wrapper = Join-Path $workDir "scripts\run-digest.ps1"

if (-not (Test-Path $wrapper)) {
    Write-Host "[FAIL] wrapper not found: $wrapper" -ForegroundColor Red
    exit 1
}

# Action: invoke the PowerShell wrapper from the project root.
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`"" `
    -WorkingDirectory $workDir

# Triggers: daily 09:00 + at logon (whichever comes first wins; same-day
# repeats are blocked by MultipleInstances=IgnoreNew below).
$trigger = @(
    (New-ScheduledTaskTrigger -Daily -At 9am),
    (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)
)

# Principal: current user, only when logged on (no stored password, simplest).
$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

# Settings: wake the PC if it's asleep at 9am; start late if PC was off.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -WakeToRun `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew

# Remove any prior version of this task before re-registering.
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed existing task: $taskName"
}

Register-ScheduledTask `
    -TaskName $taskName `
    -Trigger $trigger `
    -Action $action `
    -Principal $principal `
    -Settings $settings `
    -Description "Mention Brief - daily Teams mention digest" | Out-Null

Write-Host ""
Write-Host "[OK] Task registered: $taskName" -ForegroundColor Green
Write-Host "  Trigger    : daily 09:00 (local time)"
Write-Host "  Action     : $wrapper"
Write-Host "  Workdir    : $workDir"
Write-Host "  Logs       : $workDir\logs\digest-YYYY-MM-DD.log"
Write-Host ""
Write-Host "Quick test (runs immediately, behaves exactly like the scheduled run):"
Write-Host "  Start-ScheduledTask -TaskName $taskName"
Write-Host "  Get-Content `"$workDir\logs\digest-$(Get-Date -Format yyyy-MM-dd).log`" -Wait"
