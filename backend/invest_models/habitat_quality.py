import csv
import json
from pathlib import Path
from typing import Callable

from .common import (
    SUPPORTED_RASTER_SUFFIXES,
    SUPPORTED_TABLE_SUFFIXES,
    SUPPORTED_VECTOR_SUFFIXES,
    check_raster_pair_alignment,
    code_sort_key,
    normalized_csv_headers,
    optional_asset_path,
    read_raster_codes,
    require_asset,
    safe_asset_path,
)

REQUIRED_THREATS_COLUMNS = {"threat", "max_dist", "weight", "decay", "cur_path"}
REQUIRED_SENSITIVITY_COLUMNS = {"lucode", "habitat"}

MODEL_SCHEMA = {
    "id": "habitat_quality",
    "invest_version": "3.19.0",
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
            "semantic_terms": ["lulc", "land cover", "land use", "current"],
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
            "semantic_terms": ["threats", "threat table", "pressure"],
            "required_fields": ["threat", "max_dist", "weight", "decay", "cur_path"],
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
            "semantic_terms": ["sensitivity", "habitat sensitivity", "habitat"],
            "required_fields": ["lucode", "habitat"],
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
            "semantic_terms": ["lulc", "land cover", "future", "scenario"],
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
            "semantic_terms": ["lulc", "land cover", "baseline"],
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
    "matching_relations": [
        {
            "kind": "code-coverage",
            "left_slot": "lulc_cur_path",
            "right_slot": "sensitivity_table_path",
            "field": "lucode",
        },
        {
            "kind": "code-coverage",
            "left_slot": "lulc_fut_path",
            "right_slot": "sensitivity_table_path",
            "field": "lucode",
        },
        {
            "kind": "code-coverage",
            "left_slot": "lulc_bas_path",
            "right_slot": "sensitivity_table_path",
            "field": "lucode",
        },
    ],
    "outputs": [
        {"name": "quality_c_{results_suffix}.tif", "type": "raster", "map_default": True},
        {"name": "deg_sum_c_{results_suffix}.tif", "type": "raster", "map_default": True},
        {"name": "quality_f_{results_suffix}.tif", "type": "raster", "map_default": False},
        {"name": "rarity_c_{results_suffix}.tif", "type": "raster", "map_default": False},
    ],
}


def read_threat_names(path: Path) -> tuple[list[str], list[str]]:
    headers = normalized_csv_headers(path)
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
    headers = normalized_csv_headers(path)
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
        SUPPORTED_RASTER_SUFFIXES,
    )
    threats_path = require_asset(
        errors,
        assets_dir,
        str(inputs.get("threats_table_asset_id") or ""),
        "Threats table",
        SUPPORTED_TABLE_SUFFIXES,
    )
    sensitivity_path = require_asset(
        errors,
        assets_dir,
        str(inputs.get("sensitivity_table_asset_id") or ""),
        "Sensitivity table",
        SUPPORTED_TABLE_SUFFIXES,
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
            SUPPORTED_RASTER_SUFFIXES,
        )
    if include_baseline:
        baseline_path = require_asset(
            errors,
            assets_dir,
            str(inputs.get("lulc_hq_bas_asset_id") or ""),
            "Baseline LULC raster",
            SUPPORTED_RASTER_SUFFIXES,
        )

    access_id = str(inputs.get("access_vector_asset_id") or "")
    if access_id:
        access_path = optional_asset_path(assets_dir, access_id)
        if not access_path or not access_path.exists():
            errors.append(f"Accessibility vector asset was not found: {access_id}")
        elif access_path.suffix.lower() not in SUPPORTED_VECTOR_SUFFIXES:
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
            warnings.extend(check_raster_pair_alignment(current_path, future_path, "Current", "future LULC"))
        except Exception as exc:
            warnings.append(f"Could not compare current and future raster alignment: {exc}")

    if baseline_path and current_path:
        try:
            warnings.extend(check_raster_pair_alignment(current_path, baseline_path, "Current", "baseline LULC"))
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


def log(handle, message: str) -> None:
    handle.write(f"{message}\n")
    handle.flush()


def required_safe_asset_path(assets_dir: Path, asset_id: str, label: str, suffixes: set[str]) -> Path:
    if not asset_id:
        raise ValueError(f"{label} is required")
    path = safe_asset_path(assets_dir, asset_id)
    if not path.exists() or not path.is_file():
        raise ValueError(f"{label} asset does not exist: {asset_id}")
    if path.suffix.lower() not in suffixes:
        raise ValueError(f"{label} must use one of these formats: {', '.join(sorted(suffixes))}")
    return path


def optional_safe_asset_path(assets_dir: Path, asset_id: str, label: str, suffixes: set[str]) -> Path | None:
    if not asset_id:
        return None
    path = safe_asset_path(assets_dir, asset_id)
    if not path.exists() or not path.is_file():
        raise ValueError(f"{label} asset does not exist: {asset_id}")
    if path.suffix.lower() not in suffixes:
        raise ValueError(f"{label} must use one of these formats: {', '.join(sorted(suffixes))}")
    return path


def build_invest_args(job_inputs: dict, assets_dir: Path, workspace_dir: Path) -> dict:
    current_path = required_safe_asset_path(
        assets_dir,
        str(job_inputs.get("lulc_cur_asset_id") or ""),
        "current LULC raster",
        SUPPORTED_RASTER_SUFFIXES,
    )
    threats_table_path = required_safe_asset_path(
        assets_dir,
        str(job_inputs.get("threats_table_asset_id") or ""),
        "threats table",
        SUPPORTED_TABLE_SUFFIXES,
    )
    sensitivity_table_path = required_safe_asset_path(
        assets_dir,
        str(job_inputs.get("sensitivity_table_asset_id") or ""),
        "sensitivity table",
        SUPPORTED_TABLE_SUFFIXES,
    )

    try:
        half_saturation_constant = float(job_inputs.get("half_saturation_constant"))
    except (TypeError, ValueError) as exc:
        raise ValueError("half_saturation_constant must be numeric") from exc
    if half_saturation_constant <= 0:
        raise ValueError("half_saturation_constant must be greater than 0")

    include_future = bool(job_inputs.get("include_future", False))
    include_baseline = bool(job_inputs.get("include_baseline", False))
    future_path = optional_safe_asset_path(
        assets_dir,
        str(job_inputs.get("lulc_fut_asset_id") or "") if include_future else "",
        "future LULC raster",
        SUPPORTED_RASTER_SUFFIXES,
    )
    baseline_path = optional_safe_asset_path(
        assets_dir,
        str(job_inputs.get("lulc_hq_bas_asset_id") or "") if include_baseline else "",
        "baseline LULC raster",
        SUPPORTED_RASTER_SUFFIXES,
    )
    access_vector_path = optional_safe_asset_path(
        assets_dir,
        str(job_inputs.get("access_vector_asset_id") or ""),
        "accessibility vector",
        SUPPORTED_VECTOR_SUFFIXES,
    )

    invest_args = {
        "workspace_dir": str(workspace_dir),
        "lulc_cur_path": str(current_path),
        "threats_table_path": str(threats_table_path),
        "sensitivity_table_path": str(sensitivity_table_path),
        "half_saturation_constant": half_saturation_constant,
        "results_suffix": str(job_inputs.get("results_suffix") or "hq_mvp"),
        "n_workers": int(job_inputs.get("n_workers", -1)),
    }
    if future_path:
        invest_args["lulc_fut_path"] = str(future_path)
    if baseline_path:
        invest_args["lulc_bas_path"] = str(baseline_path)
    if access_vector_path:
        invest_args["access_vector_path"] = str(access_vector_path)
    return invest_args


def inspect_threat_table_paths(threats_table_path: Path) -> dict:
    headers = normalized_csv_headers(threats_table_path)
    path_columns = [column for column in ("cur_path", "fut_path", "base_path") if column in headers]
    missing_by_column: dict[str, list[str]] = {}
    present_by_column: dict[str, list[str]] = {}

    with threats_table_path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            for column in path_columns:
                raw_value = str(row.get(headers[column], "")).strip()
                if not raw_value:
                    continue
                resolved = (threats_table_path.parent / raw_value).resolve()
                target = present_by_column if resolved.exists() else missing_by_column
                target.setdefault(column, []).append(raw_value)

    return {
        "path_columns": path_columns,
        "present_by_column": present_by_column,
        "missing_by_column": missing_by_column,
    }


def run_job(
    job_id: str,
    job_inputs: dict,
    assets_dir: Path,
    workspace_dir: Path,
    outputs_dir: Path,
    run_mode: str,
    handle,
) -> None:
    log(handle, "preparing Habitat Quality job")
    log(handle, f"run mode: {run_mode}")
    log(handle, "runner state: schema/check ready; real Habitat execution is not wired yet")

    invest_args = build_invest_args(job_inputs, assets_dir, workspace_dir)
    threats_table_path = Path(invest_args["threats_table_path"])
    threat_path_report = inspect_threat_table_paths(threats_table_path)

    log(handle, f"current LULC asset: {job_inputs.get('lulc_cur_asset_id') or 'missing'}")
    log(handle, f"threats table asset: {job_inputs.get('threats_table_asset_id') or 'missing'}")
    log(handle, f"sensitivity table asset: {job_inputs.get('sensitivity_table_asset_id') or 'missing'}")
    log(handle, f"include future scenario: {bool(job_inputs.get('include_future', False))}")
    log(handle, f"include baseline scenario: {bool(job_inputs.get('include_baseline', False))}")
    log(handle, f"results suffix: {invest_args['results_suffix']}")
    log(handle, f"mapped InVEST args: {', '.join(sorted(invest_args))}")

    if threat_path_report["path_columns"]:
        log(handle, "threat raster paths are resolved by InVEST relative to the threats table directory")
        for column, missing_paths in threat_path_report["missing_by_column"].items():
            preview = ", ".join(missing_paths[:8])
            log(handle, f"WARN: {len(missing_paths)} {column} path(s) do not exist next to the threats table: {preview}")
    else:
        log(handle, "WARN: threats table has no threat raster path columns to inspect")

    outputs_dir.mkdir(exist_ok=True)
    (outputs_dir / "habitat_quality_args_preview.json").write_text(
        json.dumps(
            {
                "job_id": job_id,
                "model_id": "habitat_quality",
                "runner_state": "not_implemented",
                "invest_args": invest_args,
                "threat_path_report": threat_path_report,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    log(handle, "wrote habitat_quality_args_preview.json")

    raise RuntimeError(
        "Habitat Quality real execution is not implemented yet. "
        "Next step: add a sample package importer that keeps threats_table_path "
        "and threat raster relative paths together, then call natcap.invest.habitat_quality.execute."
    )
