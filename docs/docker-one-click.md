# One-Click Linux Docker Deployment

On the Linux server, start the complete GSMS stack from the repository root:

```bash
sh scripts/start_docker_gsms.sh
```

This builds and starts:

- PostgreSQL/PostGIS
- GSMS backend and database migrations
- GSMS frontend
- persisted InVEST Agent Worker

Open `http://<server-ip>:3000`. Only the frontend is exposed on all network
interfaces by default. PostgreSQL is internal to Compose, and the backend port
is bound to `127.0.0.1`.

The Worker uses the default LLM Provider configured in GSMS through the
backend-only model proxy. It never receives the saved API key.

Stop the stack:

```bash
sh scripts/stop_docker_gsms.sh
```

Useful diagnostics:

```bash
docker compose ps
docker compose logs -f backend agent-worker
```

## Existing Provider API Keys

Provider API keys are stored in PostgreSQL encrypted with `FERNET_KEY`. The
Linux start script generates `.env` on first launch and preserves its
`GSMS_FERNET_KEY` on every later launch, so newly saved API keys survive
container restarts.

An API key configured in the GSMS database on this server is available to the
Agent automatically. A key configured in a different local GSMS database is
not transferred to the server; configure it once in the server's Settings
page.

Older keys saved while `FERNET_KEY` was empty may have been encrypted with an
ephemeral process key. If Agent requests fail with a decryption error after
this upgrade, open GSMS Settings and save that Provider API key once more.

Also verify that the configured Provider Base URL is reachable from the Linux
backend container. A URL such as `http://localhost:...` refers to the container
itself, not your laptop or another server.

## Server Configuration

The start script creates `.env` automatically. Back it up with the database
volume, especially:

```text
GSMS_FERNET_KEY
GSMS_AGENT_PROXY_TOKEN
```

You may edit host bindings and ports in `.env`. Keep `GSMS_FERNET_KEY` stable
after saving Provider API keys.

For Windows-only development, the PowerShell wrappers remain available:

```powershell
.\scripts\start_docker_gsms.ps1
.\scripts\stop_docker_gsms.ps1
```
