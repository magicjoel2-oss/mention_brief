# Verbose retry for STAGE 2 only.
# Goal: surface the real underlying error (AADSTS code or network failure)
# that 'Connect-MgGraph' wraps as "Error occurred while writing to the listener".
#
# Instructions:
#   1. Run this script.
#   2. When device-code URL/code appear, OPEN the URL in your browser,
#      enter the code, sign in with your @nexon.co.kr account,
#      and CLICK "Yes" / "Continue" on the consent page.
#   3. Wait for the browser to say "You have signed in to the
#      Microsoft Graph Command Line Tools application on your device."
#   4. Then come back to this PowerShell window and watch the output.

$ErrorActionPreference = "Stop"
$VerbosePreference = "Continue"
$DebugPreference = "Continue"

Import-Module Microsoft.Graph.Authentication

Write-Host "Attempting Connect-MgGraph with -Debug ..." -ForegroundColor Cyan
Write-Host "Watch for any 'AADSTS' substring in the output below." -ForegroundColor Yellow
Write-Host ""

try {
    Connect-MgGraph `
        -Scopes @("User.Read", "Chat.Read") `
        -UseDeviceCode `
        -NoWelcome `
        -Debug `
        -Verbose
    Write-Host ""
    Write-Host "[OK] Connect-MgGraph returned successfully." -ForegroundColor Green
    Get-MgContext | Format-List Account, TenantId, Scopes, AuthType
} catch {
    Write-Host ""
    Write-Host "==== EXCEPTION DETAILS ====" -ForegroundColor Red
    Write-Host ("Type    : {0}" -f $_.Exception.GetType().FullName)
    Write-Host ("Message : {0}" -f $_.Exception.Message)

    $inner = $_.Exception.InnerException
    $depth = 0
    while ($null -ne $inner -and $depth -lt 5) {
        Write-Host ("Inner[{0}] {1}" -f $depth, $inner.GetType().FullName) -ForegroundColor Yellow
        Write-Host ("          {0}" -f $inner.Message)
        $inner = $inner.InnerException
        $depth++
    }

    Write-Host ""
    Write-Host "==== FULL ERROR RECORD ====" -ForegroundColor Red
    $_ | Format-List * -Force | Out-String | Write-Host
}
