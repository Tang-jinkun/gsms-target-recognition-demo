"""GSMS FastAPI application.

B1 refactor: DB initialisation + new scene router added.
All original routes kept intact (assets/models/jobs/health/sample-data)
so the existing frontend workbench continues to work unchanged during migration.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from invest_models.registry import check_model_inputs, get_model_schema, list_model_schemas

# New modules added in B1
from app.db import get_db, init_db
from app.models import Job as DbJob
from app.routers import scenes as scenes_router
from app.routers import data as data_router
from app.routers import scene_files as scene_files_router
from app.routers import jobs as scene_jobs_router
from app.routers import skills as skills_router
from app.routers import settings as settings_router
from app.routers import matching as matching_router
from app.routers import agent as agent_router
from app.files_util import (
    infer_file_type as infer_asset_type,
    infer_file_format as infer_asset_format,
    read_file_metadata as read_asset_metadata,
    read_geojson_file as read_geojson_asset,
    generate_raster_preview as _generate_raster_preview_png,
    get_job_status_from_log,
    calculate_geojson_bounds,
    merge_bounds,
)

# ── Legacy paths (kept for existing routes during migration) ───────────────────
from app.storage import legacy_assets_dir, legacy_jobs_dir

ASSETS_DIR = legacy_assets_dir()
JOBS_DIR = legacy_jobs_dir()
ASSET_PREVIEWS_DIR = Path(__file__).resolve().parents[1] / "data" / "projects" / "default" / "assets_previews"
ASSET_PREVIEWS_DIR.mkdir(parents=True, exist_ok=True)

SAMPLE_CARBON_DIR = Path(__file__).resolve().parents[2] / "sample_data" / "carbon"

app = FastAPI(title="GSMS — InVEST WebGIS Workbench")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000", "http://localhost:3001", "http://localhost:3002",
        "http://127.0.0.1:3000", "http://127.0.0.1:3001", "http://127.0.0.1:3002",
    ],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register new routers
app.include_router(scenes_router.router)
app.include_router(data_router.router)
app.include_router(scene_files_router.router)
app.include_router(scene_jobs_router.router)
app.include_router(skills_router.router)
app.include_router(settings_router.router)
app.include_router(matching_router.router)
app.include_router(agent_router.router)


@app.on_event("startup")
def on_startup():
    init_db()


# ── Health ─────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


# ── Models (unchanged) ─────────────────────────────────────────────────────────

@app.get("/api/models")
async def list_models():
    return list_model_schemas()


@app.get("/api/models/{model_id}/schema")
async def model_schema(model_id: str):
    model = get_model_schema(model_id)
    if model:
        return model
    raise HTTPException(status_code=404, detail="Model not found")


@app.post("/api/models/carbon/check-inputs")
async def check_carbon_inputs(payload: dict):
    inputs = payload.get("inputs") if isinstance(payload.get("inputs"), dict) else payload
    return check_model_inputs("carbon", inputs, ASSETS_DIR, read_asset_metadata)


@app.post("/api/models/{model_id}/check-inputs")
async def check_inputs_for_model(model_id: str, payload: dict):
    inputs = payload.get("inputs") if isinstance(payload.get("inputs"), dict) else payload
    try:
        return check_model_inputs(model_id, inputs, ASSETS_DIR, read_asset_metadata)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Model not found") from exc


# ── Assets (unchanged, legacy — will alias to Data Hub in B2) ─────────────────

def get_asset_path(asset_id: str) -> Path:
    safe_name = Path(asset_id).name
    asset_path = ASSETS_DIR / safe_name
    if not asset_path.exists() or not asset_path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset_path


def asset_summary(path: Path) -> dict:
    summary = {
        "id": path.name,
        "name": path.name,
        "type": infer_asset_type(path.name),
        "path": str(path),
        "size": path.stat().st_size,
    }
    if path.suffix.lower() in {".tif", ".tiff"}:
        summary["preview_url"] = f"/api/assets/{path.name}/preview.png"
    if path.suffix.lower() in {".geojson", ".json", ".tif", ".tiff"}:
        try:
            meta = read_asset_metadata(path)
            for key in ("bounds", "bounds_wgs84", "crs"):
                if meta.get(key):
                    summary[key] = meta[key]
        except Exception:
            pass
    return summary


def unique_asset_destination(filename: str) -> Path:
    safe_name = Path(filename or "upload.bin").name
    dest = ASSETS_DIR / safe_name
    if dest.exists():
        orig = Path(safe_name)
        dest = ASSETS_DIR / f"{orig.stem}.{uuid.uuid4().hex}{orig.suffix}"
    return dest


def persist_upload_file(file: UploadFile) -> dict:
    dest = unique_asset_destination(file.filename or "upload.bin")
    try:
        with dest.open("wb") as fh:
            shutil.copyfileobj(file.file, fh)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save {file.filename}: {exc}") from exc
    return asset_summary(dest)


@app.get("/api/assets")
async def list_assets():
    return [asset_summary(p) for p in sorted(ASSETS_DIR.iterdir()) if p.is_file()]


@app.get("/api/assets/{asset_id}/metadata")
async def asset_metadata(asset_id: str):
    return read_asset_metadata(get_asset_path(asset_id))


@app.get("/api/assets/{asset_id}/geojson")
async def asset_geojson(asset_id: str):
    return read_geojson_asset(get_asset_path(asset_id))


@app.api_route("/api/assets/{asset_id}/preview.png", methods=["GET", "HEAD"])
async def asset_preview_png(asset_id: str, request: Request, max_size: int = 1024):
    asset_path = get_asset_path(asset_id)
    if asset_path.suffix.lower() not in {".tif", ".tiff"}:
        raise HTTPException(status_code=400, detail="Asset is not a GeoTIFF")
    preview_path = ASSET_PREVIEWS_DIR / f"{asset_path.name}.png"
    try:
        if request.method == "HEAD":
            headers = {"Content-Type": "image/png"}
            if preview_path.exists():
                headers["Content-Length"] = str(preview_path.stat().st_size)
            return Response(status_code=200, headers=headers)
        if preview_path.exists() and preview_path.stat().st_mtime >= asset_path.stat().st_mtime:
            return FileResponse(str(preview_path), media_type="image/png")
        _generate_raster_preview_png(asset_path, preview_path, max_size=max_size)
        return FileResponse(str(preview_path), media_type="image/png")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to generate preview: {exc}")


@app.post("/api/assets/upload")
async def upload_asset(file: UploadFile = File(...)):
    return persist_upload_file(file)


@app.post("/api/assets/upload-many")
async def upload_many_assets(files: list[UploadFile] = File(...)):
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")
    return {"count": len(files), "imported": [persist_upload_file(f) for f in files]}


@app.delete("/api/assets/{asset_id}")
async def delete_asset(asset_id: str):
    asset_path = get_asset_path(asset_id)
    asset_path.unlink()
    return {"id": asset_path.name, "deleted": True}


@app.post("/api/sample-data/carbon/import")
async def import_sample_carbon_data():
    if not SAMPLE_CARBON_DIR.exists():
        raise HTTPException(status_code=404, detail="sample_data/carbon not found.")
    allowed = {".tif", ".tiff", ".csv", ".geojson", ".json", ".zip"}
    imported, roles = [], {}
    for src in sorted(SAMPLE_CARBON_DIR.iterdir()):
        if not src.is_file() or src.suffix.lower() not in allowed:
            continue
        dest = ASSETS_DIR / src.name
        if not dest.exists():
            shutil.copy2(src, dest)
        summary = asset_summary(dest)
        lower = src.name.lower()
        role = None
        if lower.endswith(".csv") and "carbon_pools" in lower:
            role = "carbon_pools"
        elif lower.endswith((".tif", ".tiff")) and "lulc_current" in lower:
            role = "baseline_lulc"
        elif lower.endswith((".tif", ".tiff")) and "lulc_future" in lower:
            role = "alternate_lulc"
        if role:
            summary["sample_role"] = role
            roles[role] = summary["id"]
        imported.append(summary)
    if not imported:
        raise HTTPException(status_code=404, detail="No supported sample files found.")
    return {"imported": imported, "roles": roles}


# ── Jobs (unchanged, legacy — will move to /api/scenes/{id}/jobs in B3) ───────

def get_job_output_path(job_id: str, filename: str) -> Path:
    safe_name = Path(filename).name
    output_path = JOBS_DIR / job_id / "outputs" / safe_name
    if not output_path.exists() or not output_path.is_file():
        raise HTTPException(status_code=404, detail="Output not found")
    return output_path


def job_summary(job_dir: Path) -> dict:
    job_json = job_dir / "job.json"
    payload = {}
    if job_json.exists():
        try:
            payload = json.loads(job_json.read_text(encoding="utf-8"))
        except Exception:
            pass
    inputs = payload.get("inputs") if isinstance(payload.get("inputs"), dict) else {}
    outputs_dir = job_dir / "outputs"
    outputs_count = sum(1 for p in outputs_dir.iterdir() if p.is_file()) if outputs_dir.exists() else 0
    completed_at = None
    if outputs_dir.exists():
        files = [p for p in outputs_dir.iterdir() if p.is_file()]
        if files:
            completed_at = max(p.stat().st_mtime for p in files)
    return {
        "job_id": job_dir.name,
        "status": get_job_status_from_log(job_dir),
        "model_id": payload.get("modelId") or payload.get("model_id") or "carbon",
        "run_mode": payload.get("run_mode") or "auto",
        "results_suffix": inputs.get("results_suffix"),
        "outputs_count": outputs_count,
        "created_at": job_json.stat().st_mtime if job_json.exists() else job_dir.stat().st_mtime,
        "completed_at": completed_at,
    }


def output_summary(job_id: str, path: Path) -> dict:
    summary = {
        "id": f"{job_id}:{path.name}",
        "job_id": job_id,
        "name": path.name,
        "type": infer_asset_type(path.name),
        "size": path.stat().st_size,
        "download_url": f"/api/jobs/{job_id}/outputs/{path.name}/download",
    }
    if path.suffix.lower() in {".tif", ".tiff"}:
        summary["preview_url"] = f"/api/jobs/{job_id}/outputs/{path.name}/preview.png"
    if path.suffix.lower() in {".geojson", ".json"}:
        summary["geojson_url"] = f"/api/jobs/{job_id}/outputs/{path.name}/geojson"
    if path.suffix.lower() in {".geojson", ".json", ".tif", ".tiff"}:
        try:
            meta = read_asset_metadata(path)
            for key in ("bounds", "bounds_wgs84", "crs"):
                if meta.get(key):
                    summary[key] = meta[key]
        except Exception:
            pass
    return summary


@app.post("/api/jobs")
async def create_job(payload: dict, db: Session = Depends(get_db)):
    scene_id = payload.get("scene_id")
    if scene_id:
        body = scene_jobs_router.JobCreateIn(**payload)
        return scene_jobs_router.create_scene_job(str(scene_id), body, db)

    job_id = uuid.uuid4().hex
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "job.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    (job_dir / "run.log").write_text("Job created\n", encoding="utf-8")
    runner = Path(__file__).resolve().parents[1] / "run_job.py"
    subprocess.Popen(
        [sys.executable, str(runner), "--job-id", job_id],
        cwd=str(runner.parent),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    return {"job_id": job_id, "status": "running", "job_dir": str(job_dir)}


@app.get("/api/jobs")
async def list_jobs(limit: int = 20):
    jobs = [job_summary(d) for d in JOBS_DIR.iterdir() if d.is_dir() and (d / "run.log").exists()]
    jobs.sort(key=lambda j: j["created_at"], reverse=True)
    return jobs[:max(1, min(limit, 100))]


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str, db: Session = Depends(get_db)):
    db_job = db.get(DbJob, job_id)
    if db_job:
        return scene_jobs_router.get_scene_job(db_job.scene_id, job_id, db)

    job_dir = JOBS_DIR / job_id
    if not (job_dir / "run.log").exists():
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job_id": job_id, "status": get_job_status_from_log(job_dir)}


@app.get("/api/jobs/{job_id}/logs")
async def job_logs(job_id: str, db: Session = Depends(get_db)):
    db_job = db.get(DbJob, job_id)
    if db_job:
        return scene_jobs_router.get_scene_job_logs(db_job.scene_id, job_id, db)

    job_log = JOBS_DIR / job_id / "run.log"
    if not job_log.exists():
        raise HTTPException(status_code=404, detail="Job or logs not found")
    return FileResponse(str(job_log))


@app.get("/api/jobs/{job_id}/outputs")
async def job_outputs(job_id: str, db: Session = Depends(get_db)):
    db_job = db.get(DbJob, job_id)
    if db_job:
        return scene_jobs_router.list_scene_job_outputs(db_job.scene_id, job_id, db)

    outputs_dir = JOBS_DIR / job_id / "outputs"
    if not outputs_dir.exists():
        return []
    return [output_summary(job_id, p) for p in sorted(outputs_dir.iterdir()) if p.is_file()]


@app.get("/api/jobs/{job_id}/outputs/{filename}/download")
async def download_job_output(job_id: str, filename: str, db: Session = Depends(get_db)):
    db_job = db.get(DbJob, job_id)
    if db_job:
        return scene_jobs_router.download_scene_job_output(db_job.scene_id, job_id, filename)

    path = get_job_output_path(job_id, filename)
    return FileResponse(str(path), filename=path.name)


@app.get("/api/jobs/{job_id}/outputs/{filename}/geojson")
async def job_output_geojson(job_id: str, filename: str, db: Session = Depends(get_db)):
    db_job = db.get(DbJob, job_id)
    if db_job:
        return scene_jobs_router.scene_job_output_geojson(db_job.scene_id, job_id, filename)

    return read_geojson_asset(get_job_output_path(job_id, filename))


@app.api_route("/api/jobs/{job_id}/outputs/{filename}/preview.png", methods=["GET", "HEAD"])
async def job_output_preview_png(
    job_id: str,
    filename: str,
    request: Request,
    max_size: int = 1024,
    db: Session = Depends(get_db),
):
    db_job = db.get(DbJob, job_id)
    if db_job:
        return scene_jobs_router.scene_job_output_preview(db_job.scene_id, job_id, filename, request, max_size)

    output_path = get_job_output_path(job_id, filename)
    if output_path.suffix.lower() not in {".tif", ".tiff"}:
        raise HTTPException(status_code=400, detail="Output is not a GeoTIFF")
    previews_dir = JOBS_DIR / job_id / "previews"
    preview_path = previews_dir / f"{output_path.name}.png"
    try:
        if request.method == "HEAD":
            headers = {"Content-Type": "image/png"}
            if preview_path.exists():
                headers["Content-Length"] = str(preview_path.stat().st_size)
            return Response(status_code=200, headers=headers)
        if preview_path.exists() and preview_path.stat().st_mtime >= output_path.stat().st_mtime:
            return FileResponse(str(preview_path), media_type="image/png")
        _generate_raster_preview_png(output_path, preview_path, max_size=max_size)
        return FileResponse(str(preview_path), media_type="image/png")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to generate output preview: {exc}")
