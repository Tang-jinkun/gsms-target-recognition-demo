"""Scene-scoped model jobs and per-job outputs."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import files_util
from app.db import get_db
from app.models import DataFile, Job, JobOutput, Scene, SceneImport
from app.storage import project_files_dir, scene_job_dir

router = APIRouter(prefix="/api/scenes", tags=["scene-jobs"])


class JobCreateIn(BaseModel):
    modelId: str | None = None
    model_id: str | None = None
    run_mode: str = "auto"
    inputs: dict = Field(default_factory=dict)


def _require_scene(scene_id: str, db: Session) -> Scene:
    scene = db.get(Scene, scene_id)
    if not scene:
        raise HTTPException(status_code=404, detail="Scene not found")
    return scene


def _job_dir(scene_id: str, job_id: str) -> Path:
    return scene_job_dir(scene_id, job_id)


def _job_log(scene_id: str, job_id: str) -> Path:
    return _job_dir(scene_id, job_id) / "run.log"


def _output_path(scene_id: str, job_id: str, filename: str) -> Path:
    safe_name = Path(filename).name
    path = _job_dir(scene_id, job_id) / "outputs" / safe_name
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Output not found")
    return path


def _scene_file_map(scene_id: str, db: Session) -> dict[str, DataFile]:
    rows = (
        db.query(DataFile)
        .join(SceneImport, SceneImport.file_id == DataFile.id)
        .filter(SceneImport.scene_id == scene_id)
        .all()
    )
    mapped: dict[str, DataFile] = {}
    for df in rows:
        mapped[df.id] = df
        mapped[df.name] = df
        mapped[Path(df.path).name] = df
    return mapped


def _normalize_inputs(scene_id: str, inputs: dict, db: Session) -> dict:
    """Accept Data Hub IDs from scene files, but pass filenames to model runners."""
    mapped = _scene_file_map(scene_id, db)
    normalized = dict(inputs or {})
    for key, value in list(normalized.items()):
        if not key.endswith("_asset_id") or not value:
            continue
        df = mapped.get(str(value))
        if df:
            normalized[key] = Path(df.path).name
    return normalized


def _output_dict(scene_id: str, job_id: str, output: JobOutput) -> dict:
    base = f"/api/scenes/{scene_id}/jobs/{job_id}/outputs/{output.name}"
    return {
        "id": output.id,
        "job_id": job_id,
        "name": output.name,
        "type": output.file_type,
        "size": output.size,
        "bounds": output.bounds,
        "bounds_wgs84": output.bounds_wgs84,
        "crs": output.crs,
        "download_url": f"{base}/download",
        "preview_url": f"{base}/preview.png" if output.file_type == "raster" else None,
        "geojson_url": f"{base}/geojson" if output.file_type == "geojson" else None,
    }


def _sync_job_from_disk(scene_id: str, job: Job, db: Session) -> Job:
    job_dir = _job_dir(scene_id, job.id)
    log_dir = job_dir if job_dir.exists() else None
    if log_dir:
        status = files_util.get_job_status_from_log(log_dir)
        job.status = status
        if status in {"succeeded", "failed"} and job.completed_at is None:
            job.completed_at = datetime.utcnow()

    outputs_dir = job_dir / "outputs"
    outputs = [p for p in sorted(outputs_dir.iterdir()) if p.is_file()] if outputs_dir.exists() else []
    existing = {o.name: o for o in job.outputs}
    for path in outputs:
        meta = {}
        if path.suffix.lower() in {".geojson", ".json", ".tif", ".tiff"}:
            try:
                meta = files_util.read_file_metadata(path)
            except Exception:
                meta = {}
        output = existing.get(path.name)
        if not output:
            output = JobOutput(id=f"{job.id}:{path.name}", job_id=job.id, name=path.name, path=path.name)
            db.add(output)
        output.file_type = meta.get("file_type") or files_util.infer_file_type(path.name)
        output.size = path.stat().st_size
        output.path = path.name
        output.bounds = meta.get("bounds")
        output.bounds_wgs84 = meta.get("bounds_wgs84")
        output.crs = meta.get("crs")
    job.outputs_count = len(outputs)
    db.commit()
    db.refresh(job)
    return job


def _job_dict(scene_id: str, job: Job) -> dict:
    return {
        "job_id": job.id,
        "scene_id": scene_id,
        "status": job.status,
        "model_id": job.model_id,
        "run_mode": job.run_mode,
        "results_suffix": job.results_suffix,
        "outputs_count": job.outputs_count,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
    }


@router.post("/{scene_id}/jobs", status_code=201)
def create_scene_job(scene_id: str, body: JobCreateIn, db: Session = Depends(get_db)):
    _require_scene(scene_id, db)
    job_id = uuid.uuid4().hex
    model_id = body.model_id or body.modelId or "carbon"
    inputs = _normalize_inputs(scene_id, body.inputs, db)
    job = Job(
        id=job_id,
        scene_id=scene_id,
        model_id=model_id,
        run_mode=body.run_mode or "auto",
        status="running",
        inputs=inputs,
        results_suffix=inputs.get("results_suffix"),
    )
    db.add(job)
    db.commit()

    job_dir = _job_dir(scene_id, job_id)
    payload = {"modelId": model_id, "run_mode": job.run_mode, "inputs": inputs, "scene_id": scene_id}
    (job_dir / "job.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    (job_dir / "run.log").write_text("Job created\n", encoding="utf-8")
    runner = Path(__file__).resolve().parents[2] / "run_job.py"
    subprocess.Popen(
        [
            sys.executable,
            str(runner),
            "--job-id",
            job_id,
            "--scene-id",
            scene_id,
            "--job-dir",
            str(job_dir),
            "--assets-dir",
            str(project_files_dir()),
        ],
        cwd=str(runner.parent),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    return {"job_id": job_id, "status": "running", "scene_id": scene_id, "job_dir": str(job_dir)}


@router.get("/{scene_id}/jobs")
def list_scene_jobs(scene_id: str, limit: int = 20, db: Session = Depends(get_db)):
    _require_scene(scene_id, db)
    rows = (
        db.query(Job)
        .filter(Job.scene_id == scene_id)
        .order_by(Job.created_at.desc())
        .limit(max(1, min(limit, 100)))
        .all()
    )
    return [_job_dict(scene_id, _sync_job_from_disk(scene_id, job, db)) for job in rows]


@router.get("/{scene_id}/jobs/{job_id}")
def get_scene_job(scene_id: str, job_id: str, db: Session = Depends(get_db)):
    _require_scene(scene_id, db)
    job = db.get(Job, job_id)
    if not job or job.scene_id != scene_id:
        raise HTTPException(status_code=404, detail="Job not found")
    return _job_dict(scene_id, _sync_job_from_disk(scene_id, job, db))


@router.get("/{scene_id}/jobs/{job_id}/logs")
def get_scene_job_logs(scene_id: str, job_id: str, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job or job.scene_id != scene_id:
        raise HTTPException(status_code=404, detail="Job not found")
    log_path = _job_log(scene_id, job_id)
    if not log_path.exists():
        raise HTTPException(status_code=404, detail="Job logs not found")
    return FileResponse(str(log_path))


@router.get("/{scene_id}/jobs/{job_id}/outputs")
def list_scene_job_outputs(scene_id: str, job_id: str, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job or job.scene_id != scene_id:
        raise HTTPException(status_code=404, detail="Job not found")
    job = _sync_job_from_disk(scene_id, job, db)
    return [_output_dict(scene_id, job_id, output) for output in sorted(job.outputs, key=lambda o: o.name)]


@router.get("/{scene_id}/jobs/{job_id}/outputs/{filename}/download")
def download_scene_job_output(scene_id: str, job_id: str, filename: str):
    path = _output_path(scene_id, job_id, filename)
    return FileResponse(str(path), filename=path.name)


@router.get("/{scene_id}/jobs/{job_id}/outputs/{filename}/geojson")
def scene_job_output_geojson(scene_id: str, job_id: str, filename: str):
    return files_util.read_geojson_file(_output_path(scene_id, job_id, filename))


@router.api_route("/{scene_id}/jobs/{job_id}/outputs/{filename}/preview.png", methods=["GET", "HEAD"])
def scene_job_output_preview(scene_id: str, job_id: str, filename: str, request: Request, max_size: int = 1024):
    output_path = _output_path(scene_id, job_id, filename)
    if output_path.suffix.lower() not in {".tif", ".tiff"}:
        raise HTTPException(status_code=400, detail="Output is not a GeoTIFF")
    preview_dir = _job_dir(scene_id, job_id) / "previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    preview = preview_dir / f"{output_path.name}.png"
    if request.method == "HEAD":
        headers = {"Content-Type": "image/png"}
        if preview.exists():
            headers["Content-Length"] = str(preview.stat().st_size)
        return Response(status_code=200, headers=headers)
    if preview.exists() and preview.stat().st_mtime >= output_path.stat().st_mtime:
        return FileResponse(str(preview), media_type="image/png")
    files_util.generate_raster_preview(output_path, preview, max_size=max_size)
    return FileResponse(str(preview), media_type="image/png")
