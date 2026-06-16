# =============================================================================
# Mention Brief - Auth PoC (Option A: Microsoft.Graph PowerShell + Device Code)
# =============================================================================
# Goal: verify whether company IdP policy blocks PowerShell device-code flow.
#       On success, prints one chat message via Chat.Read scope.
#
# Run (PowerShell 7 recommended, 5.1 also works):
#   PS> cd C:\AiApps\mention_brief
#   PS> .\scripts\auth-poc.ps1
#
# Result guide:
#   STAGE 1..4 all OK  -> Option A is viable. Proceed to generate-digest.mjs.
#   STAGE 2 FAIL       -> IdP blocks the flow. Switch to Option D (Edge CDP).
#   STAGE 5 FAIL       -> Search scope missing. Use list-chats fallback later.
# =============================================================================

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Stage($n, $msg) {
    Write-Host ""
    Write-Host ("==== STAGE {0} : {1} ====" -f $n, $msg) -ForegroundColor Cyan
}
function Write-Ok($msg)   { Write-Host ("[OK] {0}"   -f $msg) -ForegroundColor Green }
function Write-Fail($msg) { Write-Host ("[FAIL] {0}" -f $msg) -ForegroundColor Red }

# -----------------------------------------------------------------------------
Write-Stage 1 "Check/install Microsoft.Graph.Authentication module"
# -----------------------------------------------------------------------------
$mod = Get-Module -ListAvailable -Name Microsoft.Graph.Authentication |
       Sort-Object Version -Descending | Select-Object -First 1

if ($null -eq $mod) {
    Write-Host "Module not found. Installing from PSGallery (CurrentUser scope)..."
    try {
        if ((Get-PSRepository -Name PSGallery).InstallationPolicy -ne "Trusted") {
            Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
        }
        Install-Module Microsoft.Graph.Authentication -Scope CurrentUser -Force -AllowClobber
        Write-Ok "Installed Microsoft.Graph.Authentication"
    } catch {
        Write-Fail ("Install failed: {0}" -f $_.Exception.Message)
        Write-Host "Company policy may block PSGallery. Consider switching to Option D." -ForegroundColor Yellow
        exit 1
    }
} else {
    Write-Ok ("Already installed (v{0})" -f $mod.Version)
}

Import-Module Microsoft.Graph.Authentication

# -----------------------------------------------------------------------------
Write-Stage 2 "Connect-MgGraph (device code flow)"
# -----------------------------------------------------------------------------
# This is the most likely choke point. If blocked, capture the AADSTS code.
$scopes = @("User.Read", "Chat.Read", "ChatMessage.Read")

try {
    Connect-MgGraph -Scopes $scopes -UseDeviceCode -NoWelcome
    Write-Ok "Connect-MgGraph succeeded"
} catch {
    Write-Fail ("Connect-MgGraph failed: {0}" -f $_.Exception.Message)
    Write-Host ""
    Write-Host "If you see an AADSTS error code above, that is the key diagnostic:" -ForegroundColor Yellow
    Write-Host "  AADSTS50020/53003 -> Conditional Access blocking"               -ForegroundColor Yellow
    Write-Host "  AADSTS700016      -> app ID not allowed"                        -ForegroundColor Yellow
    Write-Host "  AADSTS65001       -> admin consent required"                    -ForegroundColor Yellow
    Write-Host "Copy the full error to Claude Code; we will switch to Option D."  -ForegroundColor Yellow
    exit 1
}

$ctx = Get-MgContext
Write-Host ("  Account : {0}" -f $ctx.Account)
Write-Host ("  TenantId: {0}" -f $ctx.TenantId)
Write-Host ("  Scopes  : {0}" -f ($ctx.Scopes -join ', '))

# -----------------------------------------------------------------------------
Write-Stage 3 "Self profile (/me)"
# -----------------------------------------------------------------------------
try {
    $me = Invoke-MgGraphRequest -Method GET -Uri "https://graph.microsoft.com/v1.0/me"
    Write-Ok "Got /me"
    Write-Host ("  displayName       : {0}" -f $me.displayName)
    Write-Host ("  userPrincipalName : {0}" -f $me.userPrincipalName)
    Write-Host ("  id (userId)       : {0}" -f $me.id)
    if ($me.id -ne "2185dfaa-243b-4541-ba33-1f223e81ccf9") {
        Write-Host "  WARN: userId differs from spec - update generate-digest.mjs later." -ForegroundColor Yellow
    }
} catch {
    Write-Fail ("/me failed: {0}" -f $_.Exception.Message)
    exit 1
}

# -----------------------------------------------------------------------------
Write-Stage 4 "List chats + sample message (/me/chats)"
# -----------------------------------------------------------------------------
try {
    $uri = 'https://graph.microsoft.com/v1.0/me/chats?$top=3&$orderby=lastUpdatedDateTime desc'
    $chats = Invoke-MgGraphRequest -Method GET -Uri $uri
    Write-Ok ("Got {0} chat(s)" -f $chats.value.Count)

    if ($chats.value.Count -gt 0) {
        $sampleChat = $chats.value[0]
        $label = if ($sampleChat.topic) { $sampleChat.topic } else { "(no topic, type=$($sampleChat.chatType))" }
        Write-Host ("  sample chat : {0}" -f $label)
        Write-Host ("  chatId      : {0}" -f $sampleChat.id)

        try {
            $msgUri = "https://graph.microsoft.com/v1.0/me/chats/$($sampleChat.id)/messages?`$top=1"
            $msgs = Invoke-MgGraphRequest -Method GET -Uri $msgUri
            if ($msgs.value.Count -gt 0) {
                $m = $msgs.value[0]
                $content = "$($m.body.content)"
                $preview = if ($content.Length -gt 100) { $content.Substring(0,100) + "..." } else { $content }
                Write-Ok "Got 1 message"
                Write-Host ("  from    : {0}" -f $m.from.user.displayName)
                Write-Host ("  time    : {0}" -f $m.createdDateTime)
                Write-Host ("  preview : {0}" -f $preview)
            }
        } catch {
            Write-Fail ("Messages fetch failed: {0}" -f $_.Exception.Message)
        }
    }
} catch {
    Write-Fail ("/me/chats failed: {0}" -f $_.Exception.Message)
    exit 1
}

# -----------------------------------------------------------------------------
Write-Stage 5 "Mention search (/search/query) - matches spec section 4.2 step 2"
# -----------------------------------------------------------------------------
$bodyObj = @{
    requests = @(@{
        entityTypes = @("chatMessage")
        query       = @{ queryString = "mentions:magicjoel" }
        from        = 0
        size        = 5
    })
}
$body = $bodyObj | ConvertTo-Json -Depth 10

try {
    $result = Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/search/query" -Body $body
    $hits = $result.value[0].hitsContainers[0].hits
    Write-Ok ("Search returned {0} hit(s)" -f $hits.Count)
    if ($hits.Count -gt 0) {
        $summary = "$($hits[0].summary)"
        $cut = [Math]::Min(120, $summary.Length)
        Write-Host ("  first hit : {0}" -f $summary.Substring(0, $cut))
    } else {
        Write-Host "  (0 hits - the keyword 'magicjoel' may not match your UPN. Fallback later.)"
    }
} catch {
    Write-Fail ("Search failed: {0}" -f $_.Exception.Message)
    Write-Host "Likely missing scope. We can fall back to chat enumeration in next step." -ForegroundColor Yellow
}

# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "==== Summary ====" -ForegroundColor Cyan
Write-Host "If STAGE 4 passed, Option A is viable - proceed to digest script."
Write-Host "If STAGE 5 failed, we will use chat enumeration instead of /search."
Write-Host ""
Write-Host "Next: paste this entire output back to Claude Code."
