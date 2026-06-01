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

Open:

```text
http://SERVER_IP:3002/workbench
```

The frontend proxies `/api/*` requests to the backend container, so the browser
does not need to know the backend container hostname.

## Ports

```text
3002  Next.js frontend
8000  FastAPI backend, exposed for direct API checks
```

For a quick health check:

```bash
curl http://SERVER_IP:8000/health
```

If the server is public, open port `3002` at minimum. Port `8000` is useful for
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
  environment from `backend/environment.yml`.
- The frontend image builds Next.js with `NEXT_PUBLIC_API_URL=""`, so browser
  requests are relative and go through the Next.js rewrite proxy.
- The first backend build can be slow because it downloads conda-forge packages,
  including `natcap.invest`, GDAL, rasterio, and geopandas. Later builds reuse
  Docker cache unless `backend/environment.yml` changes.
