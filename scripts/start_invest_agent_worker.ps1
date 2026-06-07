param(
    [string]$GsmsUrl = "http://127.0.0.1:8000",
    [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"
if (-not $env:GSMS_AGENT_PROXY_TOKEN) {
    throw "Set GSMS_AGENT_PROXY_TOKEN before starting the Agent Worker."
}
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$agentDir = Join-Path $repoRoot "agent"
$env:GSMS_URL = $GsmsUrl
if ($Workspace) { $env:INVEST_AGENT_WORKSPACE = $Workspace }

Push-Location $agentDir
try {
    npm run worker
} finally {
    Pop-Location
}
