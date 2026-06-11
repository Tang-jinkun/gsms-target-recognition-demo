"""File-processing utilities shared between Data Hub and job output handlers.

Extracted verbatim from the original app/main.py so existing behaviour is
preserved exactly while both routers can import from one place.
"""
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path

from fastapi import HTTPException


def infer_file_type(filename: str) -> str:
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


def infer_file_format(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    return {
        ".tif": "geotiff", ".tiff": "geotiff",
        ".geojson": "geojson", ".json": "geojson",
        ".zip": "shapefile_zip", ".csv": "csv",
        ".html": "html", ".htm": "html", ".txt": "text",
    }.get(suffix, "unknown")


def calculate_geojson_bounds(geometry: dict) -> list[float] | None:
    values: list[tuple[float, float]] = []

    def walk(value):
        if not isinstance(value, list):
            return
        if len(value) >= 2 and all(isinstance(i, (int, float)) for i in value[:2]):
            values.append((float(value[0]), float(value[1])))
            return
        for item in value:
            walk(item)

    walk(geometry.get("coordinates"))
    if not values:
        return None
    xs = [v[0] for v in values]
    ys = [v[1] for v in values]
    return [min(xs), min(ys), max(xs), max(ys)]


def merge_bounds(bounds: list[list[float]]) -> list[float] | None:
    if not bounds:
        return None
    return [min(b[0] for b in bounds), min(b[1] for b in bounds),
            max(b[2] for b in bounds), max(b[3] for b in bounds)]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_vector_property_profile(features: list[dict], sample_limit: int = 12) -> dict:
    geometry_types = Counter()
    property_values: dict[str, list] = {}

    for feature in features:
        geometry = feature.get("geometry") or {}
        geometry_types[str(geometry.get("type") or "Unknown")] += 1
        properties = feature.get("properties") or {}
        if not isinstance(properties, dict):
            continue
        for name, value in properties.items():
            property_values.setdefault(str(name), []).append(value)

    fields = []
    for name, values in sorted(property_values.items()):
        null_count = len(features) - len(values) + sum(value is None for value in values)
        non_null = [value for value in values if value is not None]
        value_types = {infer_property_type(value) for value in non_null}
        inferred_type = next(iter(value_types)) if len(value_types) == 1 else "mixed"
        if not non_null:
            inferred_type = "null"
        distinct = []
        seen = set()
        for value in non_null:
            key = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
            if key in seen:
                continue
            seen.add(key)
            if len(distinct) < sample_limit and isinstance(value, (str, int, float, bool)):
                distinct.append(value)
        field = {
            "name": name,
            "inferred_type": inferred_type,
            "null_count": null_count,
            "distinct_count": len(seen),
            "sampled_values": distinct,
            "sampled_values_complete": len(seen) <= sample_limit,
        }
        numeric = [float(value) for value in non_null if isinstance(value, (int, float)) and not isinstance(value, bool)]
        if inferred_type == "number" and numeric:
            field["numeric_stats"] = {"minimum": min(numeric), "maximum": max(numeric)}
        fields.append(field)

    return {
        "feature_count": len(features),
        "geometry_types": dict(sorted(geometry_types.items())),
        "fields": fields,
    }


def infer_property_type(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "mixed"


def read_file_metadata(path: Path) -> dict:
    metadata: dict = {
        "name": path.name,
        "file_type": infer_file_type(path.name),
        "file_format": infer_file_format(path.name),
        "size": path.stat().st_size,
    }
    suffix = path.suffix.lower()

    if suffix == ".csv":
        with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as fh:
            reader = csv.reader(fh)
            headers = next(reader, [])
            sample_rows, row_count = [], 0
            for row in reader:
                row_count += 1
                if len(sample_rows) < 3:
                    sample_rows.append(row)
        metadata.update({"columns": headers, "row_count": row_count, "sample_rows": sample_rows})
        return metadata

    if suffix in {".geojson", ".json"}:
        with path.open("r", encoding="utf-8-sig", errors="replace") as fh:
            data = json.load(fh)
        features = data.get("features", []) if data.get("type") == "FeatureCollection" else []
        bounds = [b for b in (calculate_geojson_bounds((f.get("geometry") or {})) for f in features) if b]
        metadata.update({
            "feature_count": len(features),
            "bounds": merge_bounds(bounds),
            "bounds_wgs84": merge_bounds(bounds),
            "crs": "EPSG:4326",
            "vector_property_profile": build_vector_property_profile(features),
            "sha256": file_sha256(path),
        })
        return metadata

    if suffix in {".tif", ".tiff"}:
        try:
            import rasterio
            from rasterio.warp import transform_bounds
            with rasterio.open(path) as ds:
                native = [ds.bounds.left, ds.bounds.bottom, ds.bounds.right, ds.bounds.top]
                wgs84 = None
                if ds.crs:
                    try:
                        w, s, e, n = transform_bounds(ds.crs, "EPSG:4326", *native, densify_pts=21)
                        wgs84 = [w, s, e, n]
                    except Exception:
                        pass
                metadata.update({
                    "crs": str(ds.crs) if ds.crs else None,
                    "bounds": native, "bounds_wgs84": wgs84,
                    "width": ds.width, "height": ds.height,
                    "band_count": ds.count, "nodata": ds.nodata, "dtypes": list(ds.dtypes),
                })
        except Exception as exc:
            metadata["metadata_error"] = str(exc)
        return metadata

    if suffix == ".zip":
        metadata["note"] = "Shapefile zip metadata extraction is not enabled yet."
        return metadata

    if suffix in {".txt", ".html", ".htm"}:
        metadata["preview"] = path.read_text(encoding="utf-8", errors="replace")[:500]
        return metadata

    return metadata


def read_geojson_file(path: Path) -> dict:
    if path.suffix.lower() not in {".geojson", ".json"}:
        raise HTTPException(status_code=400, detail="File is not GeoJSON")
    try:
        with path.open("r", encoding="utf-8-sig", errors="replace") as fh:
            data = json.load(fh)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid GeoJSON: {exc}") from exc

    t = data.get("type")
    if t == "FeatureCollection":
        return data
    if t == "Feature":
        return {"type": "FeatureCollection", "features": [data]}
    if t in {"Point","MultiPoint","LineString","MultiLineString","Polygon","MultiPolygon"}:
        return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": data}]}
    raise HTTPException(status_code=400, detail="Unsupported GeoJSON object")


def generate_raster_preview(source_path: Path, dest_path: Path, max_size: int = 1024) -> None:
    import numpy as np
    from PIL import Image
    import rasterio
    from rasterio.enums import Resampling

    safe_max = max(128, min(int(max_size), 2048))
    with rasterio.open(source_path) as ds:
        scale = min(safe_max / ds.width, safe_max / ds.height, 1.0)
        ow, oh = max(1, int(ds.width * scale)), max(1, int(ds.height * scale))
        indexes = [1, 2, 3] if ds.count >= 3 else [1]
        data = ds.read(indexes=indexes, out_shape=(len(indexes), oh, ow),
                       resampling=Resampling.nearest, masked=True)
        mask = np.ma.getmaskarray(data[0])
        alpha = np.where(mask, 0, 255).astype(np.uint8)
        filled = np.ma.filled(data.astype(np.float32), np.nan)

        def scale_band(b: np.ndarray) -> np.ndarray:
            valid = b[np.isfinite(b)]
            if valid.size == 0:
                return np.zeros(b.shape, dtype=np.uint8)
            lo, hi = np.nanpercentile(valid, [2, 98])
            if not (np.isfinite(lo) and np.isfinite(hi) and hi > lo):
                lo, hi = float(np.nanmin(valid)), float(np.nanmax(valid))
            if not (np.isfinite(lo) and np.isfinite(hi) and hi > lo):
                return np.zeros(b.shape, dtype=np.uint8)
            s = np.clip((b - lo) / (hi - lo), 0, 1)
            s = np.where(np.isfinite(s), s, 0.0)
            return (s * 255).astype(np.uint8)

        if filled.shape[0] == 1:
            gray = scale_band(filled[0])
            rgb = np.stack([gray, gray, gray], axis=-1)
        else:
            rgb = np.stack([scale_band(filled[i]) for i in range(3)], axis=-1)

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.dstack([rgb, alpha]), mode="RGBA").save(dest_path, format="PNG", optimize=True)


def get_job_status_from_log(job_dir: Path) -> str:
    log = job_dir / "run.log"
    if not log.exists():
        return "missing"
    text = log.read_text(encoding="utf-8", errors="replace")
    if "=== job runner finished ===" in text:
        return "succeeded"
    if "ERROR" in text or "failed" in text.lower():
        return "failed"
    return "running"


def ingest_vector_features(path: Path, file_id: str, db) -> int:
    """Parse GeoJSON/SHP and bulk-insert into the features table. Returns count."""
    from app.models import Feature
    import geopandas as gpd
    from shapely.geometry import mapping
    import json

    suffix = path.suffix.lower()
    try:
        if suffix in {".geojson", ".json"}:
            gdf = gpd.read_file(path)
        elif suffix == ".zip":
            gdf = gpd.read_file(f"zip://{path}")
        else:
            return 0
    except Exception:
        return 0

    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")

    count = 0
    for _, row in gdf.iterrows():
        if row.geometry is None:
            continue
        props = {k: v for k, v in row.items() if k != "geometry"}
        # Convert non-serialisable values to str
        safe_props = {}
        for k, v in props.items():
            try:
                json.dumps(v)
                safe_props[k] = v
            except (TypeError, ValueError):
                safe_props[k] = str(v)

        from geoalchemy2.shape import from_shape
        feat = Feature(
            file_id=file_id,
            geom=from_shape(row.geometry, srid=4326),
            properties=safe_props,
        )
        db.add(feat)
        count += 1
    db.commit()
    return count
