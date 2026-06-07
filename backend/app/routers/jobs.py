"""Scene-scoped model jobs and per-job outputs."""
from __future__ import annotations

import json
import os
import shutil
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
from app.job_inputs import freeze_snapshot_inputs
from app.models import DataFile, DataFolder, Job, JobOutput, Scene, SceneImport
from app.result_analysis import (
    analyze_job_outputs,
    file_sha256,
    fingerprints_unchanged,
    load_analysis,
    save_analysis,
)
from app.storage import project_files_dir, scene_job_dir
from invest_models.registry import get_model_schema

router = APIRouter(prefix="/api/scenes", tags=["scene-jobs"])
UNCATEGORIZED_FOLDER_ID = "uncategorized"


class JobCreateIn(BaseModel):
    modelId: str | None = None
    model_id: str | None = None
    run_mode: str = "auto"
    inputs: dict = Field(default_factory=dict)


def create_scene_job_record(
    scene_id: str,
    model_id: str,
    inputs: dict,
    run_mode: str,
    db: Session,
    source_snapshot_id: str | None = None,
    asset_fingerprints: dict | None = None,
) -> dict:
    job_id = uuid.uuid4().hex
    job_dir = _job_dir(scene_id, job_id)
    frozen_inputs = inputs
    assets_dir = project_files_dir()
    manifest = None
    if source_snapshot_id:
        try:
            frozen_inputs, manifest = freeze_snapshot_inputs(
                job_dir,
                project_files_dir(),
                inputs,
                asset_fingerprints or {},
            )
        except Exception:
            shutil.rmtree(job_dir, ignore_errors=True)
            raise
        assets_dir = job_dir / "inputs"
    job = Job(
        id=job_id,
        scene_id=scene_id,
        model_id=model_id,
        run_mode=run_mode or "auto",
        status="running",
        inputs=frozen_inputs,
        results_suffix=frozen_inputs.get("results_suffix"),
        source_snapshot_id=source_snapshot_id,
    )
    payload = {
        "modelId": model_id,
        "run_mode": job.run_mode,
        "inputs": frozen_inputs,
        "scene_id": scene_id,
    }
    if source_snapshot_id:
        payload["source_snapshot_id"] = source_snapshot_id
        manifest.update({
            "source_snapshot_id": source_snapshot_id,
            "scene_id": scene_id,
            "model_id": model_id,
            "inputs": frozen_inputs,
        })
    try:
        (job_dir / "job.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
        if manifest:
            (job_dir / "input-manifest.json").write_text(
                json.dumps(manifest, indent=2),
                encoding="utf-8",
            )
        (job_dir / "run.log").write_text("Job created\n", encoding="utf-8")
        db.add(job)
        db.commit()
    except Exception:
        db.rollback()
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    runner = Path(__file__).resolve().parents[2] / "run_job.py"
    try:
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
                str(assets_dir),
            ],
            cwd=str(runner.parent),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except Exception:
        job.status = "failed"
        job.completed_at = datetime.utcnow()
        db.commit()
        raise
    return {"job_id": job_id, "status": "running", "scene_id": scene_id, "job_dir": str(job_dir)}


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


def _task_folder_name(job: Job) -> str:
    stamp = (job.completed_at or job.created_at or datetime.utcnow()).strftime("%Y%m%d_%H%M%S")
    return f"{job.model_id}_{stamp}"


def _ensure_task_folder(job: Job, db: Session) -> DataFolder:
    name = _task_folder_name(job)
    folder = db.query(DataFolder).filter(DataFolder.name == name).first()
    if folder:
        return folder
    folder = DataFolder(id=uuid.uuid4().hex, name=name)
    db.add(folder)
    db.flush()
    return folder


def _unique_project_dest(src: Path, job: Job) -> Path:
    files_dir = project_files_dir()
    stem = src.stem
    suffix = src.suffix
    dest = files_dir / f"{job.id}_{src.name}"
    if not dest.exists():
        return dest
    i = 1
    while True:
        candidate = files_dir / f"{job.id}_{stem}_{i}{suffix}"
        if not candidate.exists():
            return candidate
        i += 1


def _existing_output_data_file(job_id: str, output_name: str, db: Session) -> DataFile | None:
    rows = db.query(DataFile).all()
    for df in rows:
        meta = df.extra_meta or {}
        if meta.get("source") == "job_output" and meta.get("job_id") == job_id and meta.get("output_name") == output_name:
            return df
    return None


def _register_outputs_to_data_hub(scene_id: str, job: Job, outputs: list[Path], db: Session) -> None:
    if job.status != "succeeded" or not outputs:
        return
    folder = _ensure_task_folder(job, db)
    for path in outputs:
        df = _existing_output_data_file(job.id, path.name, db)
        if not df:
            dest = _unique_project_dest(path, job)
            shutil.copy2(path, dest)
            try:
                meta = files_util.read_file_metadata(dest)
            except Exception:
                meta = {
                    "file_type": files_util.infer_file_type(dest.name),
                    "file_format": dest.suffix.lower().lstrip(".") or "unknown",
                    "size": dest.stat().st_size,
                }
            core = {"name", "file_type", "file_format", "size", "crs", "bounds", "bounds_wgs84"}
            extra = {k: v for k, v in meta.items() if k not in core}
            extra.update({"source": "job_output", "job_id": job.id, "scene_id": scene_id, "output_name": path.name})
            df = DataFile(
                id=uuid.uuid4().hex,
                folder_id=folder.id,
                name=path.name,
                file_type=meta.get("file_type", "unknown"),
                file_format=meta.get("file_format", dest.suffix.lower().lstrip(".") or "unknown"),
                size=meta.get("size", dest.stat().st_size),
                path=dest.name,
                crs=meta.get("crs"),
                bounds=meta.get("bounds"),
                bounds_wgs84=meta.get("bounds_wgs84"),
                extra_meta=extra,
            )
            db.add(df)
            db.flush()
            if df.file_type == "geojson":
                try:
                    files_util.ingest_vector_features(dest, df.id, db)
                except Exception:
                    pass
        else:
            df.folder_id = folder.id
        if not db.get(SceneImport, {"scene_id": scene_id, "file_id": df.id}):
            db.add(SceneImport(scene_id=scene_id, file_id=df.id))


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
    _register_outputs_to_data_hub(scene_id, job, outputs, db)
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
    model_id = body.model_id or body.modelId or "carbon"
    inputs = _normalize_inputs(scene_id, body.inputs, db)
    return create_scene_job_record(scene_id, model_id, inputs, body.run_mode, db)


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


# ---------------------------------------------------------------------------
# Result Analysis
# ---------------------------------------------------------------------------


@router.post("/{scene_id}/jobs/{job_id}/analyze-results")
def analyze_job_results(scene_id: str, job_id: str, db: Session = Depends(get_db)):
    """Deterministically analyze raster outputs of a completed job.

    Reuses cached analysis if output fingerprints have not changed.
    """
    _require_scene(scene_id, db)
    job = db.get(Job, job_id)
    if not job or job.scene_id != scene_id:
        raise HTTPException(status_code=404, detail="Job not found")
    job = _sync_job_from_disk(scene_id, job, db)
    if job.status != "succeeded":
        raise HTTPException(status_code=400, detail="Job has not succeeded; cannot analyze results")

    job_dir = _job_dir(scene_id, job_id)
    outputs_dir = job_dir / "outputs"
    if not outputs_dir.exists():
        raise HTTPException(status_code=404, detail="Job outputs directory not found")

    model_schema = get_model_schema(job.model_id)
    if not model_schema:
        raise HTTPException(status_code=400, detail=f"Unknown model: {job.model_id}")

    # Build current fingerprints for all tif files
    tif_files = sorted(
        p for p in outputs_dir.iterdir()
        if p.is_file() and p.suffix.lower() in {".tif", ".tiff"}
    )
    if not tif_files:
        raise HTTPException(status_code=400, detail="No raster outputs found to analyze")

    current_fingerprints = {p.name: file_sha256(p) for p in tif_files}

    # Reuse cached analysis if fingerprints match
    if fingerprints_unchanged(job_dir, current_fingerprints):
        cached = load_analysis(job_dir)
        return cached

    try:
        result = analyze_job_outputs(
            outputs_dir=outputs_dir,
            model_schema=model_schema,
            scene_id=scene_id,
            job_id=job_id,
            model_id=job.model_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    save_analysis(job_dir, result)
    return result


@router.get("/{scene_id}/jobs/{job_id}/result-analysis")
def get_job_result_analysis(scene_id: str, job_id: str, db: Session = Depends(get_db)):
    """Retrieve a previously computed result analysis, if available."""
    _require_scene(scene_id, db)
    job = db.get(Job, job_id)
    if not job or job.scene_id != scene_id:
        raise HTTPException(status_code=404, detail="Job not found")

    job_dir = _job_dir(scene_id, job_id)
    cached = load_analysis(job_dir)
    if not cached:
        raise HTTPException(status_code=404, detail="Result analysis not found; call analyze-results first")
    return cached
