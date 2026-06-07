param(
    [string]$CondaEnvironment = "gsms-invest",
    [string]$HostAddress = "127.0.0.1",
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$backendDir = Join-Path $repoRoot "backend"

Push-Location $backendDir
try {
    conda run -n $CondaEnvironment python scripts/migrate_startup.py
    conda run -n $CondaEnvironment python -m uvicorn app.main:app --host $HostAddress --port $Port
} finally {
    Pop-Location
}
