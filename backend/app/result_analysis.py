"""Deterministic InVEST result analysis.

Reads real GeoTIFF outputs from a completed job, computes raster statistics,
identifies output roles from the model schema, and persists a structured
result-analysis.json that the Agent can reference but never fabricate.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
from fnmatch import fnmatch
from pathlib import Path

import numpy as np

logger = logging.getLogger("result_analysis")

# ---------------------------------------------------------------------------
# Public types (documented here; validated at API boundary)
# ---------------------------------------------------------------------------

# ResultAnalysis, RasterResultAnalysis, ResultComparison — see API schema.

# ---------------------------------------------------------------------------
# Output role resolution
# ---------------------------------------------------------------------------

def resolve_output_role(
    filename: str,
    model_schema: dict,
) -> dict:
    """Match *filename* against the model schema output patterns.

    Returns ``{"role": ..., "quantity": ..., "unit": ..., "aggregation": ...}``
    or the ``unclassified`` sentinel.
    """
    results_suffix = _infer_results_suffix(filename)
    for output_def in model_schema.get("outputs", []):
        pattern = output_def.get("name", "")
        # Substitute the results_suffix placeholder so we can fnmatch.
        expanded = pattern.replace("{results_suffix}", results_suffix) if results_suffix else pattern
        if fnmatch(filename, expanded):
            role = output_def.get("role")
            if role:
                return {
                    "role": role,
                    "quantity": output_def.get("quantity", ""),
                    "unit": output_def.get("unit"),
                    "aggregation": output_def.get("aggregation"),
                }
    return {"role": "unclassified", "quantity": "", "unit": None, "aggregation": None}


def _infer_results_suffix(filename: str) -> str:
    """Best-effort extraction of the results_suffix from a Carbon output name.

    Examples:
        c_storage_bas_mvp.tif  →  "mvp"
        delta_cur_fut_test1.tif  →  "test1"
    """
    stem = Path(filename).stem
    parts = stem.split("_")
    if len(parts) >= 2:
        return parts[-1]
    return ""


# ---------------------------------------------------------------------------
# SHA-256 fingerprinting
# ---------------------------------------------------------------------------

def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Raster statistics
# ---------------------------------------------------------------------------

def compute_raster_statistics(path: Path) -> dict:
    """Read a single-band GeoTIFF and return deterministic statistics.

    Only non-nodata, non-NaN, non-Inf pixels are included in summary stats.
    """
    import rasterio

    with rasterio.open(str(path)) as src:
        band = src.read(1, masked=False).astype(np.float64)
        nodata = src.nodata
        crs = str(src.crs) if src.crs else None
        bounds = list(src.bounds)  # [left, bottom, right, top]
        width = src.width
        height = src.height

    # Build validity mask: exclude nodata, NaN, Inf
    valid_mask = np.ones(band.shape, dtype=bool)
    if nodata is not None:
        valid_mask &= ~np.isclose(band, nodata, equal_nan=True)
    valid_mask &= ~np.isnan(band)
    valid_mask &= ~np.isinf(band)

    valid_pixels = int(np.sum(valid_mask))
    nodata_pixels = int(band.size - valid_pixels)

    if valid_pixels == 0:
        return {
            "validPixels": 0,
            "nodataPixels": nodata_pixels,
            "minimum": None,
            "maximum": None,
            "mean": None,
            "total": None,
            "p05": None,
            "median": None,
            "p95": None,
            "spatial": {
                "crs": crs,
                "bounds": bounds,
                "width": width,
                "height": height,
                "nodata": nodata,
            },
        }

    valid = band[valid_mask]
    total = float(np.sum(valid))

    stats = {
        "validPixels": valid_pixels,
        "nodataPixels": nodata_pixels,
        "minimum": float(np.min(valid)),
        "maximum": float(np.max(valid)),
        "mean": float(np.mean(valid)),
        "total": total,
        "p05": float(np.percentile(valid, 5)),
        "median": float(np.median(valid)),
        "p95": float(np.percentile(valid, 95)),
        "spatial": {
            "crs": crs,
            "bounds": bounds,
            "width": width,
            "height": height,
            "nodata": nodata,
        },
    }

    return stats


def compute_change_statistics(path: Path) -> dict:
    """Extended statistics for carbon-change rasters.

    Adds positive/negative/zero pixel counts and totals on top of the
    base raster statistics.
    """
    import rasterio

    with rasterio.open(str(path)) as src:
        band = src.read(1, masked=False).astype(np.float64)
        nodata = src.nodata
        crs = str(src.crs) if src.crs else None
        bounds = list(src.bounds)
        width = src.width
        height = src.height

    valid_mask = np.ones(band.shape, dtype=bool)
    if nodata is not None:
        valid_mask &= ~np.isclose(band, nodata, equal_nan=True)
    valid_mask &= ~np.isnan(band)
    valid_mask &= ~np.isinf(band)

    valid_pixels = int(np.sum(valid_mask))
    nodata_pixels = int(band.size - valid_pixels)

    if valid_pixels == 0:
        return {
            "validPixels": 0,
            "nodataPixels": nodata_pixels,
            "minimum": None,
            "maximum": None,
            "mean": None,
            "total": None,
            "p05": None,
            "median": None,
            "p95": None,
            "positivePixels": 0,
            "negativePixels": 0,
            "zeroPixels": 0,
            "positiveTotal": 0.0,
            "negativeTotal": 0.0,
            "spatial": {
                "crs": crs,
                "bounds": bounds,
                "width": width,
                "height": height,
                "nodata": nodata,
            },
        }

    valid = band[valid_mask]
    total = float(np.sum(valid))

    positive_mask = valid > 0
    negative_mask = valid < 0
    zero_mask = valid == 0

    return {
        "validPixels": valid_pixels,
        "nodataPixels": nodata_pixels,
        "minimum": float(np.min(valid)),
        "maximum": float(np.max(valid)),
        "mean": float(np.mean(valid)),
        "total": total,
        "p05": float(np.percentile(valid, 5)),
        "median": float(np.median(valid)),
        "p95": float(np.percentile(valid, 95)),
        "positivePixels": int(np.sum(positive_mask)),
        "negativePixels": int(np.sum(negative_mask)),
        "zeroPixels": int(np.sum(zero_mask)),
        "positiveTotal": float(np.sum(valid[positive_mask])) if np.any(positive_mask) else 0.0,
        "negativeTotal": float(np.sum(valid[negative_mask])) if np.any(negative_mask) else 0.0,
        "spatial": {
            "crs": crs,
            "bounds": bounds,
            "width": width,
            "height": height,
            "nodata": nodata,
        },
    }


# ---------------------------------------------------------------------------
# Comparison checks
# ---------------------------------------------------------------------------

def check_baseline_alternate_delta_consistency(
    baseline_total: float | None,
    alternate_total: float | None,
    delta_total: float | None,
) -> dict:
    """Verify that alternate - baseline ≈ delta (within floating-point tolerance).

    Returns a ResultComparison dict.
    """
    if baseline_total is None or alternate_total is None or delta_total is None:
        return {
            "id": "baseline-alternate-change",
            "kind": "baseline-alternate-change",
            "metrics": {},
            "status": "not-applicable",
            "explanation": "One or more of baseline, alternate, or delta outputs are missing; consistency check skipped.",
        }

    computed_delta = alternate_total - baseline_total
    abs_diff = abs(computed_delta - delta_total)
    # Tolerance: relative to the magnitude of the values, with an absolute floor
    magnitude = max(abs(baseline_total), abs(alternate_total), abs(delta_total), 1.0)
    tolerance = magnitude * 1e-6 + 1e-3

    metrics = {
        "baseline_total": baseline_total,
        "alternate_total": alternate_total,
        "delta_total": delta_total,
        "computed_delta": computed_delta,
        "absolute_difference": abs_diff,
    }

    if abs_diff <= tolerance:
        return {
            "id": "baseline-alternate-change",
            "kind": "baseline-alternate-change",
            "metrics": metrics,
            "status": "passed",
            "explanation": (
                f"Alternate total ({alternate_total:.4f}) minus baseline total ({baseline_total:.4f}) "
                f"= {computed_delta:.4f}, which matches the delta raster total ({delta_total:.4f}) "
                f"within floating-point tolerance."
            ),
        }

    return {
        "id": "baseline-alternate-change",
        "kind": "baseline-alternate-change",
        "metrics": metrics,
        "status": "warning",
        "explanation": (
            f"Alternate total ({alternate_total:.4f}) minus baseline total ({baseline_total:.4f}) "
            f"= {computed_delta:.4f}, but the delta raster total is {delta_total:.4f} "
            f"(difference: {abs_diff:.6f}). This may indicate a numerical precision issue."
        ),
    }


def check_delta_internal_consistency(
    positive_total: float | None,
    negative_total: float | None,
    delta_total: float | None,
) -> dict:
    """Check that positive_total + negative_total ≈ delta_total."""
    if positive_total is None or negative_total is None or delta_total is None:
        return {
            "id": "delta-consistency",
            "kind": "delta-consistency",
            "metrics": {},
            "status": "not-applicable",
            "explanation": "Change statistics not available; internal consistency check skipped.",
        }

    computed = positive_total + negative_total
    abs_diff = abs(computed - delta_total)
    magnitude = max(abs(positive_total), abs(negative_total), abs(delta_total), 1.0)
    tolerance = magnitude * 1e-6 + 1e-3

    metrics = {
        "positive_total": positive_total,
        "negative_total": negative_total,
        "delta_total": delta_total,
        "computed_sum": computed,
        "absolute_difference": abs_diff,
    }

    if abs_diff <= tolerance:
        return {
            "id": "delta-consistency",
            "kind": "delta-consistency",
            "metrics": metrics,
            "status": "passed",
            "explanation": (
                f"Positive total ({positive_total:.4f}) + negative total ({negative_total:.4f}) "
                f"= {computed:.4f}, matching the delta total ({delta_total:.4f})."
            ),
        }

    return {
        "id": "delta-consistency",
        "kind": "delta-consistency",
        "metrics": metrics,
        "status": "warning",
        "explanation": (
            f"Positive total ({positive_total:.4f}) + negative total ({negative_total:.4f}) "
            f"= {computed:.4f}, but delta total is {delta_total:.4f} (difference: {abs_diff:.6f})."
        ),
    }


# ---------------------------------------------------------------------------
# Full analysis orchestration
# ---------------------------------------------------------------------------

def analyze_job_outputs(
    outputs_dir: Path,
    model_schema: dict,
    scene_id: str,
    job_id: str,
    model_id: str,
) -> dict:
    """Analyze all raster outputs in *outputs_dir* and return a ResultAnalysis dict.

    Corrupted individual rasters produce warnings but do not block analysis of
    remaining files. If *every* raster fails, raises ``ValueError``.
    """
    tif_files = sorted(
        p for p in outputs_dir.iterdir()
        if p.is_file() and p.suffix.lower() in {".tif", ".tiff"}
    )

    if not tif_files:
        raise ValueError(f"No raster outputs found in {outputs_dir}")

    output_fingerprints: dict[str, str] = {}
    for p in tif_files:
        output_fingerprints[p.name] = file_sha256(p)

    rasters: list[dict] = []
    warnings: list[str] = []
    any_success = False

    for tif_path in tif_files:
        filename = tif_path.name
        role_info = resolve_output_role(filename, model_schema)
        role = role_info["role"]

        try:
            if role == "carbon-change":
                stats = compute_change_statistics(tif_path)
            else:
                stats = compute_raster_statistics(tif_path)
            any_success = True
        except Exception as exc:
            warnings.append(f"Failed to analyze {filename}: {exc}")
            logger.warning("Failed to analyze %s: %s", filename, exc)
            continue

        raster_entry = {
            "id": filename,
            "filename": filename,
            "role": role,
            "quantity": role_info["quantity"],
            "unit": role_info["unit"],
            "statistics": stats,
        }
        rasters.append(raster_entry)

    if not any_success:
        raise ValueError("All raster outputs failed to analyze")

    # Build comparisons
    comparisons: list[dict] = []

    baseline_raster = _find_raster_by_role(rasters, "baseline-carbon-storage")
    alternate_raster = _find_raster_by_role(rasters, "alternate-carbon-storage")
    change_raster = _find_raster_by_role(rasters, "carbon-change")

    if baseline_raster and alternate_raster and change_raster:
        comparisons.append(check_baseline_alternate_delta_consistency(
            _safe_total(baseline_raster),
            _safe_total(alternate_raster),
            _safe_total(change_raster),
        ))
        change_stats = change_raster.get("statistics", {})
        comparisons.append(check_delta_internal_consistency(
            change_stats.get("positiveTotal"),
            change_stats.get("negativeTotal"),
            _safe_total(change_raster),
        ))

    result = {
        "sceneId": scene_id,
        "jobId": job_id,
        "modelId": model_id,
        "outputFingerprints": output_fingerprints,
        "rasters": rasters,
        "comparisons": comparisons,
        "warnings": warnings,
    }

    return result


def _find_raster_by_role(rasters: list[dict], role: str) -> dict | None:
    for r in rasters:
        if r.get("role") == role:
            return r
    return None


def _safe_total(raster: dict) -> float | None:
    stats = raster.get("statistics", {})
    total = stats.get("total")
    if total is not None and not (math.isinf(total) or math.isnan(total)):
        return total
    return None


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def analysis_path(job_dir: Path) -> Path:
    return job_dir / "analysis" / "result-analysis.json"


def save_analysis(job_dir: Path, result: dict) -> Path:
    path = analysis_path(job_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def load_analysis(job_dir: Path) -> dict | None:
    path = analysis_path(job_dir)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def fingerprints_unchanged(job_dir: Path, current_fingerprints: dict[str, str]) -> bool:
    """Return True if a cached analysis exists and its fingerprints match."""
    cached = load_analysis(job_dir)
    if not cached:
        return False
    return cached.get("outputFingerprints") == current_fingerprints
