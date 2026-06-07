param(
    [string]$GsmsUrl = "http://127.0.0.1:8000",
    [string]$SceneId = "",
    [string]$Workspace = "",
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$agentDir = Join-Path $repoRoot "agent"

try {
    $health = Invoke-RestMethod "$GsmsUrl/health" -TimeoutSec 5
    if ($health.status -ne "ok") {
        throw "GSMS health endpoint did not return status=ok"
    }
} catch {
    throw "GSMS backend is not available at $GsmsUrl. Start it before the Agent. $($_.Exception.Message)"
}

$arguments = @("start", "--", "--gsms-url", $GsmsUrl)
if ($SceneId) { $arguments += @("--scene", $SceneId) }
if ($Workspace) { $arguments += @("--workspace", $Workspace) }
if ($Yes) { $arguments += "--yes" }

Push-Location $agentDir
try {
    & npm @arguments
} finally {
    Pop-Location
}
