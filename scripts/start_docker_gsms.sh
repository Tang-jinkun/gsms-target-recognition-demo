#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

cd "$REPO_ROOT"
python3 scripts/init_docker_env.py
docker compose up --build -d
docker compose ps

FRONTEND_PORT=$(sed -n 's/^GSMS_FRONTEND_PORT=//p' .env | tail -n 1)
FRONTEND_PORT=${FRONTEND_PORT:-3000}
printf '\nGSMS is starting at http://<server-ip>:%s\n' "$FRONTEND_PORT"
printf "The Agent Worker is included. Run 'docker compose logs -f backend agent-worker' for diagnostics.\n"
