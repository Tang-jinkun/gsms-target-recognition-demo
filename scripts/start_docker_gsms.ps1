$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

Push-Location $repoRoot
try {
    python scripts/init_docker_env.py
    docker compose up --build -d
    docker compose ps
    Write-Host ""
    Write-Host "GSMS is starting at http://localhost:3000"
    Write-Host "The Agent Worker is included. Use 'docker compose logs -f agent-worker' to inspect it."
} finally {
    Pop-Location
}
