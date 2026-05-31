from fastapi import FastAPI, File, UploadFile, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pathlib import Path
import csv
import json
import shutil
import uuid
import os
import subprocess
import sys

from invest_models.carbon import check_inputs as check_carbon_model_inputs
from invest_models.registry import get_model_schema, list_model_schemas

ASSETS_DIR = Path(__file__).resolve().parents[1] / "data" / "projects" / "default" / "assets"
ASSETS_DIR.mkdir(parents=True, exist_ok=True)
ASSET_PREVIEWS_DIR = Path(__file__).resolve().parents[1] / "data" / "projects" / "default" / "assets_previews"
ASSET_PREVIEWS_DIR.mkdir(parents=True, exist_ok=True)
JOBS_DIR = Path(__file__).resolve().parents[1] / "data" / "projects" / "default" / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)

SAMPLE_CARBON_DIR = Path(__file__).resolve().parents[2] / "sample_data" / "carbon"

app = FastAPI(title="InVEST WebGIS Workbench - Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3002",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
        "http://127.0.0.1:3002",
    ],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def infer_asset_type(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix in {".tif", ".tiff"}:
        return "raster"
    if suffix in {".geojson", ".json", ".zip"}:
        return "geojson"
    if suffix == ".csv":
        return "table"
    if suffix in {".html", ".htm", ".txt"}:
        return "document"
    return "unknown"


def get_asset_path(asset_id: str) -> Path:
    safe_name = Path(asset_id).name
    asset_path = ASSETS_DIR / safe_name
    if not asset_path.exists() or not asset_path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset_path


def infer_asset_format(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    formats = {
        ".tif": "geotiff",
        ".tiff": "geotiff",
        ".geojson": "geojson",
        ".json": "geojson",
        ".zip": "shapefile_zip",
        ".csv": "csv",
        ".html": "html",
        ".htm": "html",
        ".txt": "text",
    }
    return formats.get(suffix, "unknown")


def calculate_geojson_bounds(geometry: dict) -> list[float] | None:
    values: list[tuple[float, float]] = []

    def walk(value):
        if not isinstance(value, list):
            return
        if len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
            values.append((float(value[0]), float(value[1])))
            return
        for item in value:
            walk(item)

    walk(geometry.get("coordinates"))
    if not values:
        return None
    xs = [value[0] for value in values]
    ys = [value[1] for value in values]
    return [min(xs), min(ys), max(xs), max(ys)]


def merge_bounds(bounds: list[list[float]]) -> list[float] | None:
    if not bounds:
        return None
    return [
        min(bound[0] for bound in bounds),
        min(bound[1] for bound in bounds),
        max(bound[2] for bound in bounds),
        max(bound[3] for bound in bounds),
    ]


def read_asset_metadata(path: Path) -> dict:
    metadata = {
        "id": path.name,
        "name": path.name,
        "type": infer_asset_type(path.name),
        "format": infer_asset_format(path.name),
        "size": path.stat().st_size,
    }
    suffix = path.suffix.lower()

    if suffix == ".csv":
        with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
            reader = csv.reader(handle)
            headers = next(reader, [])
            sample_rows = []
            row_count = 0
            for row in reader:
                row_count += 1
                if len(sample_rows) < 3:
                    sample_rows.append(row)
        metadata.update({
            "columns": headers,
            "row_count": row_count,
            "sample_rows": sample_rows,
        })
        return metadata

    if suffix in {".geojson", ".json"}:
        with path.open("r", encoding="utf-8-sig", errors="replace") as handle:
            data = json.load(handle)
        features = data.get("features", []) if data.get("type") == "FeatureCollection" else []
        bounds = []
        for feature in features:
            geometry = feature.get("geometry") or {}
            feature_bounds = calculate_geojson_bounds(geometry)
            if feature_bounds:
                bounds.append(feature_bounds)
        metadata.update({
            "feature_count": len(features),
            "bounds": merge_bounds(bounds),
            "crs": "EPSG:4326",
        })
        return metadata

    if suffix in {".tif", ".tiff"}:
        try:
            import rasterio
            from rasterio.warp import transform_bounds

            with rasterio.open(path) as dataset:
                native_bounds = [
                    dataset.bounds.left,
                    dataset.bounds.bottom,
                    dataset.bounds.right,
                    dataset.bounds.top,
                ]
                bounds_wgs84 = None
                if dataset.crs:
                    try:
                        west, south, east, north = transform_bounds(
                            dataset.crs,
                            "EPSG:4326",
                            native_bounds[0],
                            native_bounds[1],
                            native_bounds[2],
                            native_bounds[3],
                            densify_pts=21,
                        )
                        bounds_wgs84 = [west, south, east, north]
                    except Exception:
                        bounds_wgs84 = None

                metadata.update({
                    "crs": str(dataset.crs) if dataset.crs else None,
                    "bounds": native_bounds,
                    "bounds_wgs84": bounds_wgs84,
                    "width": dataset.width,
                    "height": dataset.height,
                    "band_count": dataset.count,
                    "nodata": dataset.nodata,
                    "dtypes": list(dataset.dtypes),
                })
        except Exception as exc:
            metadata["metadata_error"] = str(exc)
        return metadata

    if suffix == ".zip":
        metadata.update({
            "note": "Shapefile zip metadata extraction is not enabled yet.",
        })
        return metadata

    if suffix in {".txt", ".html", ".htm"}:
        metadata.update({"preview": path.read_text(encoding="utf-8", errors="replace")[:500]})
        return metadata

    return metadata


def read_geojson_asset(path: Path) -> dict:
    suffix = path.suffix.lower()
    if suffix not in {".geojson", ".json"}:
        raise HTTPException(status_code=400, detail="Asset is not a GeoJSON file")

    try:
        with path.open("r", encoding="utf-8-sig", errors="replace") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid GeoJSON: {exc}") from exc

    geojson_type = data.get("type")
    if geojson_type == "FeatureCollection":
        return data
    if geojson_type == "Feature":
        return {"type": "FeatureCollection", "features": [data]}
    if geojson_type in {"Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"}:
        return {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "properties": {},
                "geometry": data,
            }],
        }
    raise HTTPException(status_code=400, detail="Unsupported GeoJSON object")


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
            metadata = read_asset_metadata(path)
            if metadata.get("bounds"):
                summary["bounds"] = metadata["bounds"]
            if metadata.get("bounds_wgs84"):
                summary["bounds_wgs84"] = metadata["bounds_wgs84"]
            if metadata.get("crs"):
                summary["crs"] = metadata["crs"]
        except Exception:
            pass
    return summary


def _generate_raster_preview_png(source_path: Path, dest_path: Path, max_size: int) -> None:
    import numpy as np
    from PIL import Image
    import rasterio
    from rasterio.enums import Resampling

    safe_max_size = max(128, min(int(max_size), 2048))
    with rasterio.open(source_path) as dataset:
        scale = min(safe_max_size / dataset.width, safe_max_size / dataset.height, 1.0)
        out_width = max(1, int(dataset.width * scale))
        out_height = max(1, int(dataset.height * scale))

        indexes = [1, 2, 3] if dataset.count >= 3 else [1]
        data = dataset.read(
            indexes=indexes,
            out_shape=(len(indexes), out_height, out_width),
            resampling=Resampling.nearest,
            masked=True,
        )

        mask = np.ma.getmaskarray(data[0])
        alpha = np.where(mask, 0, 255).astype(np.uint8)

        filled = data.astype(np.float32)
        filled = np.ma.filled(filled, np.nan)

        def scale_band(band: np.ndarray) -> np.ndarray:
            valid = band[np.isfinite(band)]
            if valid.size == 0:
                return np.zeros(band.shape, dtype=np.uint8)
            vmin, vmax = np.nanpercentile(valid, [2, 98])
            if not np.isfinite(vmin) or not np.isfinite(vmax) or vmax <= vmin:
                vmin = float(np.nanmin(valid))
                vmax = float(np.nanmax(valid))
            if not np.isfinite(vmin) or not np.isfinite(vmax) or vmax <= vmin:
                return np.zeros(band.shape, dtype=np.uint8)
            scaled = (band - vmin) / (vmax - vmin)
            scaled = np.clip(scaled, 0, 1)
            scaled = np.nan_to_num(scaled, nan=0.0, posinf=1.0, neginf=0.0)
            # Extra safety: avoid warnings when casting NaN/inf to uint8 on some numpy versions.
            scaled = np.where(np.isfinite(scaled), scaled, 0.0)
            return (scaled * 255).astype(np.uint8)

        if filled.shape[0] == 1:
            gray = scale_band(filled[0])
            rgb = np.stack([gray, gray, gray], axis=-1)
        else:
            bands = [scale_band(filled[i]) for i in range(3)]
            rgb = np.stack(bands, axis=-1)

        rgba = np.dstack([rgb, alpha])
        img = Image.fromarray(rgba, mode="RGBA")

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest_path, format="PNG", optimize=True)


def get_job_output_path(job_id: str, filename: str) -> Path:
    safe_name = Path(filename).name
    output_path = JOBS_DIR / job_id / "outputs" / safe_name
    if not output_path.exists() or not output_path.is_file():
        raise HTTPException(status_code=404, detail="Output not found")
    return output_path


def get_job_status_from_log(job_dir: Path) -> str:
    job_log = job_dir / "run.log"
    if not job_log.exists():
        return "missing"
    log_text = job_log.read_text(encoding="utf-8", errors="replace")
    if "=== job runner finished ===" in log_text:
        return "succeeded"
    if "ERROR" in log_text or "failed" in log_text.lower():
        return "failed"
    return "running"


def job_summary(job_dir: Path) -> dict:
    job_json = job_dir / "job.json"
    payload = {}
    if job_json.exists():
        try:
            payload = json.loads(job_json.read_text(encoding="utf-8"))
        except Exception:
            payload = {}

    inputs = payload.get("inputs") if isinstance(payload.get("inputs"), dict) else {}
    outputs_dir = job_dir / "outputs"
    outputs_count = len([path for path in outputs_dir.iterdir() if path.is_file()]) if outputs_dir.exists() else 0
    completed_at = None
    if outputs_dir.exists():
        output_files = [path for path in outputs_dir.iterdir() if path.is_file()]
        if output_files:
            completed_at = max(path.stat().st_mtime for path in output_files)

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
    suffix = path.suffix.lower()
    if suffix in {".tif", ".tiff"}:
        summary["preview_url"] = f"/api/jobs/{job_id}/outputs/{path.name}/preview.png"
    if suffix in {".geojson", ".json"}:
        summary["geojson_url"] = f"/api/jobs/{job_id}/outputs/{path.name}/geojson"

    if suffix in {".geojson", ".json", ".tif", ".tiff"}:
        try:
            metadata = read_asset_metadata(path)
            if metadata.get("bounds"):
                summary["bounds"] = metadata["bounds"]
            if metadata.get("bounds_wgs84"):
                summary["bounds_wgs84"] = metadata["bounds_wgs84"]
            if metadata.get("crs"):
                summary["crs"] = metadata["crs"]
        except Exception:
            pass
    return summary


def carbon_sample_role(filename: str) -> str | None:
    lower_name = filename.lower()
    if lower_name.endswith(".csv") and "carbon_pools" in lower_name:
        return "carbon_pools"
    if lower_name.endswith((".tif", ".tiff")) and "lulc_current" in lower_name:
        return "baseline_lulc"
    if lower_name.endswith((".tif", ".tiff")) and "lulc_future" in lower_name:
        return "alternate_lulc"
    return None


@app.get("/health")
async def health():
    return {"status": "ok"}


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
    return check_carbon_model_inputs(inputs, ASSETS_DIR, read_asset_metadata)


@app.get("/api/assets")
async def list_assets():
    items = []
    for p in sorted(ASSETS_DIR.iterdir()):
        if p.is_file():
            items.append(asset_summary(p))
    return items


@app.get("/api/assets/{asset_id}/metadata")
async def asset_metadata(asset_id: str):
    asset_path = get_asset_path(asset_id)
    try:
        return read_asset_metadata(asset_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/assets/{asset_id}/geojson")
async def asset_geojson(asset_id: str):
    asset_path = get_asset_path(asset_id)
    return read_geojson_asset(asset_path)


@app.api_route("/api/assets/{asset_id}/preview.png", methods=["GET", "HEAD"])
async def asset_preview_png(asset_id: str, request: Request, max_size: int = 1024):
    asset_path = get_asset_path(asset_id)
    if asset_path.suffix.lower() not in {".tif", ".tiff"}:
        raise HTTPException(status_code=400, detail="Asset is not a GeoTIFF")

    preview_path = ASSET_PREVIEWS_DIR / f"{asset_path.name}.png"
    try:
        if request.method == "HEAD":
            # Some clients (including map renderers) probe with HEAD before issuing GET.
            # We avoid expensive generation work here; GET will generate on demand.
            headers = {"Content-Type": "image/png"}
            if preview_path.exists():
                try:
                    headers["Content-Length"] = str(preview_path.stat().st_size)
                except Exception:
                    pass
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
    filename = file.filename
    dest = ASSETS_DIR / filename
    if dest.exists():
        original = Path(filename)
        dest = ASSETS_DIR / f"{original.stem}.{uuid.uuid4().hex}{original.suffix}"
    try:
        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return asset_summary(dest)


@app.post("/api/sample-data/carbon/import")
async def import_sample_carbon_data():
    if not SAMPLE_CARBON_DIR.exists():
        raise HTTPException(
            status_code=404,
            detail="sample_data/carbon not found. See sample_data/carbon/README.md for setup.",
        )

    allowed_suffixes = {".tif", ".tiff", ".csv", ".geojson", ".json", ".zip"}
    imported: list[dict] = []
    roles: dict[str, str] = {}
    for src in sorted(SAMPLE_CARBON_DIR.iterdir()):
        if not src.is_file():
            continue
        if src.suffix.lower() not in allowed_suffixes:
            continue

        dest = ASSETS_DIR / src.name
        if not dest.exists():
            try:
                shutil.copy2(src, dest)
            except Exception as exc:
                raise HTTPException(status_code=500, detail=f"Failed to import {src.name}: {exc}") from exc

        summary = asset_summary(dest)
        sample_role = carbon_sample_role(src.name)
        if sample_role:
            summary["sample_role"] = sample_role
            roles[sample_role] = summary["id"]
        imported.append(summary)

    if not imported:
        raise HTTPException(
            status_code=404,
            detail="No supported sample files found in sample_data/carbon. See sample_data/carbon/README.md for setup.",
        )
    return {"imported": imported, "roles": roles}


@app.delete("/api/assets/{asset_id}")
async def delete_asset(asset_id: str):
    asset_path = get_asset_path(asset_id)
    asset_path.unlink()
    return {"id": asset_path.name, "deleted": True}


@app.post("/api/jobs")
async def create_job(payload: dict):
    # minimal job creation: create folder and return job id
    job_id = uuid.uuid4().hex
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    # write job.json
    (job_dir / "job.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    # create run.log placeholder
    (job_dir / "run.log").write_text("Job created\n", encoding="utf-8")

    runner = Path(__file__).resolve().parents[1] / "run_job.py"
    subprocess.Popen(
        [sys.executable, str(runner), "--job-id", job_id],
        cwd=str(runner.parent),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )

    return {"job_id": job_id, "status": "running", "job_dir": str(job_dir)}


@app.get("/api/jobs")
async def list_jobs(limit: int = 20):
    jobs = []
    for job_dir in JOBS_DIR.iterdir():
        if job_dir.is_dir() and (job_dir / "run.log").exists():
            jobs.append(job_summary(job_dir))
    jobs.sort(key=lambda item: item["created_at"], reverse=True)
    return jobs[: max(1, min(limit, 100))]


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str):
    job_dir = JOBS_DIR / job_id
    job_log = job_dir / "run.log"
    if not job_log.exists():
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job_id": job_id, "status": get_job_status_from_log(job_dir)}


@app.get("/api/jobs/{job_id}/logs")
async def job_logs(job_id: str):
    job_log = JOBS_DIR / job_id / "run.log"
    if not job_log.exists():
        raise HTTPException(status_code=404, detail="Job or logs not found")
    return FileResponse(str(job_log))


@app.get("/api/jobs/{job_id}/outputs")
async def job_outputs(job_id: str):
    outputs_dir = JOBS_DIR / job_id / "outputs"
    if not outputs_dir.exists():
        return []

    items = []
    for path in sorted(outputs_dir.iterdir()):
        if path.is_file():
            items.append(output_summary(job_id, path))
    return items


@app.get("/api/jobs/{job_id}/outputs/{filename}/download")
async def download_job_output(job_id: str, filename: str):
    output_path = get_job_output_path(job_id, filename)
    return FileResponse(str(output_path), filename=output_path.name)


@app.get("/api/jobs/{job_id}/outputs/{filename}/geojson")
async def job_output_geojson(job_id: str, filename: str):
    output_path = get_job_output_path(job_id, filename)
    return read_geojson_asset(output_path)


@app.api_route("/api/jobs/{job_id}/outputs/{filename}/preview.png", methods=["GET", "HEAD"])
async def job_output_preview_png(job_id: str, filename: str, request: Request, max_size: int = 1024):
    output_path = get_job_output_path(job_id, filename)
    if output_path.suffix.lower() not in {".tif", ".tiff"}:
        raise HTTPException(status_code=400, detail="Output is not a GeoTIFF")

    previews_dir = (JOBS_DIR / job_id / "previews")
    preview_path = previews_dir / f"{output_path.name}.png"
    try:
        if request.method == "HEAD":
            headers = {"Content-Type": "image/png"}
            if preview_path.exists():
                try:
                    headers["Content-Length"] = str(preview_path.stat().st_size)
                except Exception:
                    pass
            return Response(status_code=200, headers=headers)

        if preview_path.exists() and preview_path.stat().st_mtime >= output_path.stat().st_mtime:
            return FileResponse(str(preview_path), media_type="image/png")

        _generate_raster_preview_png(output_path, preview_path, max_size=max_size)
        return FileResponse(str(preview_path), media_type="image/png")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to generate output preview: {exc}")
