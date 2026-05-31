import csv
from pathlib import Path
from typing import Callable

from .carbon import check_raster_pair_alignment, code_sort_key, read_raster_codes

REQUIRED_THREATS_COLUMNS = {"threat", "max_dist", "weight", "decay", "cur_path"}
REQUIRED_SENSITIVITY_COLUMNS = {"lucode", "habitat"}

MODEL_SCHEMA = {
    "id": "habitat_quality",
    "name": "Habitat Quality",
    "family": "Terrestrial",
    "description": "Schema-first registration for InVEST Habitat Quality. This supports workbench parameter binding and input checks; the real runner is intentionally not wired yet.",
    "status": "schema",
    "runner": None,
    "inputs": [
        {
            "id": "lulc_cur_asset_id",
            "invest_arg": "lulc_cur_path",
            "label": "Current LULC raster",
            "help": "Current land-use/land-cover raster. Values must exist in the sensitivity table lucode column.",
            "kind": "asset",
            "asset_type": "raster",
            "group": "Required inputs",
            "required": True,
        },
        {
            "id": "threats_table_asset_id",
            "invest_arg": "threats_table_path",
            "label": "Threats table",
            "help": "CSV with threat, max_dist, weight, decay and cur_path columns. Threat raster paths are resolved by InVEST relative to this table.",
            "kind": "asset",
            "asset_type": "table",
            "group": "Required inputs",
            "required": True,
        },
        {
            "id": "sensitivity_table_asset_id",
            "invest_arg": "sensitivity_table_path",
            "label": "Sensitivity table",
            "help": "CSV with lucode, habitat and one sensitivity column for each threat.",
            "kind": "asset",
            "asset_type": "table",
            "group": "Required inputs",
            "required": True,
        },
        {
            "id": "half_saturation_constant",
            "invest_arg": "half_saturation_constant",
            "label": "Half-saturation constant",
            "help": "Positive number used in the degradation equation.",
            "kind": "number",
            "group": "Required inputs",
            "required": True,
            "default": 0.5,
            "placeholder": 0.5,
        },
        {
            "id": "include_future",
            "label": "Include future scenario",
            "help": "Adds a future LULC raster binding for scenario quality outputs.",
            "kind": "boolean",
            "group": "Scenario inputs",
            "required": False,
            "default": False,
        },
        {
            "id": "lulc_fut_asset_id",
            "invest_arg": "lulc_fut_path",
            "label": "Future LULC raster",
            "help": "Optional future LULC raster. Must use the same LULC classification as the current raster.",
            "kind": "asset",
            "asset_type": "raster",
            "group": "Scenario inputs",
            "required_if": "include_future",
            "allowed_if": "include_future",
        },
        {
            "id": "include_baseline",
            "label": "Include baseline scenario",
            "help": "Adds a baseline LULC raster binding for rarity outputs.",
            "kind": "boolean",
            "group": "Scenario inputs",
            "required": False,
            "default": False,
        },
        {
            "id": "lulc_hq_bas_asset_id",
            "invest_arg": "lulc_bas_path",
            "label": "Baseline LULC raster",
            "help": "Optional baseline LULC raster used to calculate habitat rarity.",
            "kind": "asset",
            "asset_type": "raster",
            "group": "Scenario inputs",
            "required_if": "include_baseline",
            "allowed_if": "include_baseline",
        },
        {
            "id": "access_vector_asset_id",
            "invest_arg": "access_vector_path",
            "label": "Accessibility vector",
            "help": "Optional polygon GeoJSON/shapefile asset with an access field. Cells outside polygons are treated as fully accessible.",
            "kind": "asset",
            "asset_type": "geojson",
            "group": "Optional inputs",
            "required": False,
        },
        {
            "id": "results_suffix",
            "invest_arg": "results_suffix",
            "label": "Results suffix",
            "help": "Suffix appended to model outputs.",
            "kind": "string",
            "group": "Runtime",
            "required": False,
            "default": "hq_mvp",
        },
        {
            "id": "n_workers",
            "invest_arg": "n_workers",
            "label": "Worker count",
            "help": "-1 runs synchronously. Positive values allow worker processes when supported.",
            "kind": "number",
            "group": "Runtime",
            "required": False,
            "default": -1,
            "hidden": True,
        },
    ],
    "outputs": [
        {"name": "quality_c_{results_suffix}.tif", "type": "raster", "map_default": True},
        {"name": "deg_sum_c_{results_suffix}.tif", "type": "raster", "map_default": True},
        {"name": "quality_f_{results_suffix}.tif", "type": "raster", "map_default": False},
        {"name": "rarity_c_{results_suffix}.tif", "type": "raster", "map_default": False},
    ],
}


def asset_path(assets_dir: Path, asset_id: str) -> Path | None:
    return assets_dir / Path(asset_id).name if asset_id else None


def read_csv_headers(path: Path) -> list[str]:
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.reader(handle)
        return next(reader, [])


def normalized_headers(path: Path) -> dict[str, str]:
    return {header.strip().lower(): header for header in read_csv_headers(path)}


def read_threat_names(path: Path) -> tuple[list[str], list[str]]:
    headers = normalized_headers(path)
    missing = sorted(REQUIRED_THREATS_COLUMNS - set(headers))
    if missing:
        return [], missing

    threat_field = headers["threat"]
    names: list[str] = []
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            value = str(row.get(threat_field, "")).strip()
            if value:
                names.append(value.lower())
    return names, []


def read_sensitivity_codes(path: Path) -> tuple[set[str], list[str], set[str]]:
    headers = normalized_headers(path)
    missing = sorted(REQUIRED_SENSITIVITY_COLUMNS - set(headers))
    if missing:
        return set(), missing, set(headers)

    lucode_field = headers["lucode"]
    codes: set[str] = set()
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            value = str(row.get(lucode_field, "")).strip()
            if value:
                codes.add(value[:-2] if value.endswith(".0") else value)
    return codes, [], set(headers)


def require_asset(
    errors: list[str],
    assets_dir: Path,
    asset_id: str,
    label: str,
    suffixes: set[str],
) -> Path | None:
    path = asset_path(assets_dir, asset_id)
    if not path:
        errors.append(f"{label} is required.")
        return None
    if not path.exists():
        errors.append(f"{label} asset was not found: {asset_id}")
        return None
    if path.suffix.lower() not in suffixes:
        errors.append(f"{label} must use one of these formats: {', '.join(sorted(suffixes))}.")
        return None
    return path


def check_inputs(
    inputs: dict,
    assets_dir: Path,
    read_asset_metadata: Callable[[Path], dict],
) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    info: list[str] = []
    details: dict = {}

    current_path = require_asset(
        errors,
        assets_dir,
        str(inputs.get("lulc_cur_asset_id") or ""),
        "Current LULC raster",
        {".tif", ".tiff"},
    )
    threats_path = require_asset(
        errors,
        assets_dir,
        str(inputs.get("threats_table_asset_id") or ""),
        "Threats table",
        {".csv"},
    )
    sensitivity_path = require_asset(
        errors,
        assets_dir,
        str(inputs.get("sensitivity_table_asset_id") or ""),
        "Sensitivity table",
        {".csv"},
    )

    include_future = bool(inputs.get("include_future", False))
    include_baseline = bool(inputs.get("include_baseline", False))
    future_path = None
    baseline_path = None
    if include_future:
        future_path = require_asset(
            errors,
            assets_dir,
            str(inputs.get("lulc_fut_asset_id") or ""),
            "Future LULC raster",
            {".tif", ".tiff"},
        )
    if include_baseline:
        baseline_path = require_asset(
            errors,
            assets_dir,
            str(inputs.get("lulc_hq_bas_asset_id") or ""),
            "Baseline LULC raster",
            {".tif", ".tiff"},
        )

    access_id = str(inputs.get("access_vector_asset_id") or "")
    if access_id:
        access_path = asset_path(assets_dir, access_id)
        if not access_path or not access_path.exists():
            errors.append(f"Accessibility vector asset was not found: {access_id}")
        elif access_path.suffix.lower() not in {".geojson", ".json", ".zip"}:
            errors.append("Accessibility vector must be GeoJSON or shapefile zip.")

    half_saturation = inputs.get("half_saturation_constant")
    if half_saturation in ("", None):
        errors.append("Half-saturation constant is required.")
    else:
        try:
            if float(half_saturation) <= 0:
                errors.append("Half-saturation constant must be greater than 0.")
        except (TypeError, ValueError):
            errors.append("Half-saturation constant must be numeric.")

    if errors:
        return {"status": "error", "errors": errors, "warnings": warnings, "info": info, "details": details}

    try:
        metadata = read_asset_metadata(current_path)
        details["current_lulc"] = {
            "crs": metadata.get("crs"),
            "bounds_wgs84": metadata.get("bounds_wgs84"),
            "width": metadata.get("width"),
            "height": metadata.get("height"),
        }
        if metadata.get("metadata_error"):
            errors.append(f"Current LULC raster could not be read: {metadata['metadata_error']}")
    except Exception as exc:
        errors.append(f"Current LULC raster could not be read: {exc}")

    try:
        threat_names, missing_threat_columns = read_threat_names(threats_path)
        details["threat_count"] = len(threat_names)
        details["threats"] = threat_names[:25]
        if missing_threat_columns:
            errors.append(f"Threats table is missing required columns: {', '.join(missing_threat_columns)}")
    except Exception as exc:
        errors.append(f"Threats table could not be read: {exc}")
        threat_names = []

    try:
        sensitivity_codes, missing_sensitivity_columns, sensitivity_headers = read_sensitivity_codes(sensitivity_path)
        details["sensitivity_lucode_count"] = len(sensitivity_codes)
        if missing_sensitivity_columns:
            errors.append(f"Sensitivity table is missing required columns: {', '.join(missing_sensitivity_columns)}")
        missing_threat_sensitivity = sorted(set(threat_names) - sensitivity_headers)
        if missing_threat_sensitivity:
            errors.append(
                "Sensitivity table is missing threat sensitivity column(s): "
                + ", ".join(missing_threat_sensitivity[:12])
            )
    except Exception as exc:
        errors.append(f"Sensitivity table could not be read: {exc}")
        sensitivity_codes = set()

    if not errors:
        try:
            lulc_codes = read_raster_codes(current_path)
            missing_lulc_codes = sorted(lulc_codes - sensitivity_codes, key=code_sort_key)
            unused_sensitivity_codes = sorted(sensitivity_codes - lulc_codes, key=code_sort_key)
            details["current_lulc_codes_count"] = len(lulc_codes)
            details["missing_sensitivity_lucodes"] = missing_lulc_codes[:50]
            if missing_lulc_codes:
                warnings.append(
                    f"{len(missing_lulc_codes)} LULC code(s) are missing from sensitivity lucode values: "
                    + ", ".join(missing_lulc_codes[:12])
                )
            if unused_sensitivity_codes:
                info.append(
                    f"{len(unused_sensitivity_codes)} sensitivity lucode value(s) are not present in the current LULC raster."
                )
        except Exception as exc:
            warnings.append(f"Could not compare current LULC codes with sensitivity lucode values: {exc}")

    if future_path and current_path:
        try:
            warnings.extend(check_raster_pair_alignment(current_path, future_path))
        except Exception as exc:
            warnings.append(f"Could not compare current and future raster alignment: {exc}")

    if baseline_path and current_path:
        try:
            warnings.extend(check_raster_pair_alignment(current_path, baseline_path))
        except Exception as exc:
            warnings.append(f"Could not compare current and baseline raster alignment: {exc}")

    if not errors and not warnings:
        info.append("Inputs passed basic Habitat Quality checks.")

    return {
        "status": "error" if errors else "warning" if warnings else "ok",
        "errors": errors,
        "warnings": warnings,
        "info": info,
        "details": details,
    }
