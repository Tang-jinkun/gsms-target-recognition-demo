param(
    [switch]$WithFrontend
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

Push-Location $repoRoot
try {
    if ($WithFrontend) {
        docker compose up --build db backend frontend
    } else {
        docker compose up --build db backend
    }
} finally {
    Pop-Location
}
