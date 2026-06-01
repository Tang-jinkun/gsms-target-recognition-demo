# Docker Deployment

This project can run with Docker Compose so the server does not need local Node.js,
Python, GDAL, rasterio, or InVEST installations.

## Server Prerequisites

Install only Docker Engine and the Docker Compose plugin on the server.

Ubuntu example:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Log out and back in after adding the Docker group, then verify:

```bash
docker --version
docker compose version
```

## Clone And Start

```bash
git clone https://github.com/Tang-jinkun/GSMS.git
cd GSMS
git checkout main
docker compose up --build
```

If you previously built an older Docker version and the backend exited with a
`PermissionError` under `/workspace/backend/data`, rebuild and recreate the
containers:

```bash
docker compose down
docker compose up --build
```

Open:

```text
http://SERVER_IP:3000/workbench
```

The frontend proxies `/api/*` requests to the backend container, so the browser
does not need to know the backend container hostname.

## Ports

```text
3000  Next.js frontend
8000  FastAPI backend, exposed for direct API checks
```

For a quick health check:

```bash
curl http://SERVER_IP:8000/health
```

If the server is public, open port `3000` at minimum. Port `8000` is useful for
debugging but can be closed later if a reverse proxy is added.

## Persistent Data

Runtime assets and jobs are stored in the named Docker volume:

```text
backend-data -> /workspace/backend/data
```

List volumes:

```bash
docker volume ls
```

Stop without deleting data:

```bash
docker compose down
```

Stop and delete uploaded assets/jobs:

```bash
docker compose down -v
```

## Updating

```bash
git pull
docker compose up --build -d
```

## Logs

```bash
docker compose logs -f backend
docker compose logs -f frontend
```

## Notes

- The backend image uses `mambaorg/micromamba` and creates the `gsms-invest`
  environment from `backend/environment.yml`. The Dockerfile writes a Tsinghua
  TUNA `.condarc` so conda default channels and `conda-forge` resolve through
  `https://mirrors.tuna.tsinghua.edu.cn/anaconda`. The backend container runs as
  root at runtime so the named Docker volume mounted at `/workspace/backend/data`
  can be initialized on first boot.
- The frontend image builds Next.js with `NEXT_PUBLIC_API_URL=""`, so browser
  requests are relative and go through the Next.js rewrite proxy. The frontend
  Dockerfile switches Alpine package repositories to
  `https://mirrors.tuna.tsinghua.edu.cn/alpine`. npm registry stays on the
  official registry by default because TUNA does not currently provide a working
  npm registry endpoint; it can be overridden with the `NPM_REGISTRY` build arg
  if needed.
- Docker Compose waits for the backend `/health` endpoint before starting the
  frontend, which avoids transient `getaddrinfo EAI_AGAIN backend` proxy errors
  during startup.
- The first backend build can be slow because it downloads conda-forge packages,
  including `natcap.invest`, GDAL, rasterio, and geopandas. Later builds reuse
  Docker cache unless `backend/environment.yml` changes.
