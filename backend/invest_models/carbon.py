import csv
import importlib
import json
import logging
import shutil
import time
from pathlib import Path
from typing import Callable

from .common import (
    SUPPORTED_RASTER_SUFFIXES,
    check_raster_pair_alignment,
    code_sort_key,
    index_workspace_outputs,
    log,
    normalize_code,
    optional_asset_path,
    read_raster_codes,
    safe_asset_path,
    validate_raster,
)

logger = logging.getLogger("invest.carbon")

REQUIRED_CARBON_COLUMNS = {"lucode", "c_above", "c_below", "c_soil", "c_dead"}

MODEL_SCHEMA = {
    "id": "carbon",
    "invest_version": "3.19.0",
    "name": "Carbon Storage and Sequestration",
    "family": "Terrestrial",
    "description": "Estimate carbon storage from a baseline LULC raster and carbon pools table. The runner uses natcap.invest when installed and falls back to explicit development stub outputs in auto mode.",
    "status": "auto",
    "runner": "natcap.invest.carbon.execute",
    "inputs": [
        {
            "id": "lulc_bas_asset_id",
            "invest_arg": "lulc_bas_path",
            "label": "Baseline LULC raster",
            "help": "Baseline land-use/land-cover raster. Raster values must match lucode values in the carbon pools table.",
            "kind": "asset",
            "asset_type": "raster",
            "group": "Required inputs",
            "required": True,
            "semantic_terms": ["lulc", "land cover", "land use", "baseline", "current"],
        },
        {
            "id": "carbon_pools_asset_id",
            "invest_arg": "carbon_pools_path",
            "label": "Carbon pools table",
            "help": "CSV table with lucode, c_above, c_below, c_soil and c_dead columns.",
            "kind": "asset",
            "asset_type": "table",
            "group": "Required inputs",
            "required": True,
            "semantic_terms": ["carbon pools", "carbon", "pool", "biomass"],
            "required_fields": ["lucode", "c_above", "c_below", "c_soil", "c_dead"],
        },
        {
            "id": "calc_sequestration",
            "invest_arg": "calc_sequestration",
            "label": "Calculate sequestration",
            "help": "Run baseline-to-alternate carbon change analysis.",
            "kind": "boolean",
            "group": "Scenario analysis",
            "required": False,
            "default": False,
        },
        {
            "id": "lulc_alt_asset_id",
            "invest_arg": "lulc_alt_path",
            "label": "Alternate LULC raster",
            "help": "Required when sequestration is enabled. Must align with the baseline LULC raster.",
            "kind": "asset",
            "asset_type": "raster",
            "group": "Scenario analysis",
            "required_if": "calc_sequestration",
            "allowed_if": "calc_sequestration",
            "semantic_terms": ["lulc", "land cover", "land use", "alternate", "future", "scenario"],
        },
        {
            "id": "do_valuation",
            "invest_arg": "do_valuation",
            "label": "Run valuation model",
            "help": "Calculate net present value for carbon change. Requires sequestration and baseline/alternate years.",
            "kind": "boolean",
            "group": "Valuation",
            "required": False,
            "allowed_if": "calc_sequestration",
            "default": False,
        },
        {
            "id": "lulc_bas_year",
            "invest_arg": "lulc_bas_year",
            "label": "Baseline LULC year",
            "help": "Calendar year represented by the baseline LULC raster.",
            "kind": "number",
            "group": "Valuation",
            "required_if": "do_valuation",
            "allowed_if": "do_valuation",
            "integer": True,
            "placeholder": 2020,
        },
        {
            "id": "lulc_alt_year",
            "invest_arg": "lulc_alt_year",
            "label": "Alternate LULC year",
            "help": "Calendar year represented by the alternate LULC raster. Must be greater than the baseline year.",
            "kind": "number",
            "group": "Valuation",
            "required_if": "do_valuation",
            "allowed_if": "do_valuation",
            "integer": True,
            "placeholder": 2030,
        },
        {
            "id": "price_per_metric_ton_of_c",
            "invest_arg": "price_per_metric_ton_of_c",
            "label": "Price per metric ton of carbon",
            "help": "Present value of carbon per metric ton.",
            "kind": "number",
            "group": "Valuation",
            "required_if": "do_valuation",
            "allowed_if": "do_valuation",
            "placeholder": 43,
        },
        {
            "id": "discount_rate",
            "invest_arg": "discount_rate",
            "label": "Annual discount rate",
            "help": "Annual market discount rate used for net present value calculations.",
            "kind": "number",
            "group": "Valuation",
            "required_if": "do_valuation",
            "allowed_if": "do_valuation",
            "placeholder": 7,
        },
        {
            "id": "rate_change",
            "invest_arg": "rate_change",
            "label": "Annual price change",
            "help": "Expected annual percentage change in carbon price.",
            "kind": "number",
            "group": "Valuation",
            "required_if": "do_valuation",
            "allowed_if": "do_valuation",
            "placeholder": 0,
        },
        {
            "id": "results_suffix",
            "invest_arg": "results_suffix",
            "label": "Results suffix",
            "help": "Suffix appended to model outputs.",
            "kind": "string",
            "group": "Runtime",
            "type": "string",
            "required": False,
            "default": "mvp",
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
            "left_slot": "lulc_bas_path",
            "right_slot": "carbon_pools_path",
            "field": "lucode",
        },
        {
            "kind": "code-coverage",
            "left_slot": "lulc_alt_path",
            "right_slot": "carbon_pools_path",
            "field": "lucode",
        },
    ],
    "outputs": [
        {
            "name": "c_storage_bas_{results_suffix}.tif",
            "type": "raster",
            "map_default": True,
            "role": "baseline-carbon-storage",
            "quantity": "carbon storage",
            "unit": "Mg C/pixel",
            "aggregation": "sum",
        },
        {
            "name": "c_storage_alt_{results_suffix}.tif",
            "type": "raster",
            "map_default": False,
            "role": "alternate-carbon-storage",
            "quantity": "carbon storage",
            "unit": "Mg C/pixel",
            "aggregation": "sum",
        },
        {
            "name": "delta_cur_fut_{results_suffix}.tif",
            "type": "raster",
            "map_default": False,
            "role": "carbon-change",
            "quantity": "carbon change",
            "unit": "Mg C/pixel",
            "aggregation": "sum",
        },
        {
            "name": "npv_fut_{results_suffix}.tif",
            "type": "raster",
            "map_default": False,
            "role": "valuation",
            "quantity": "net present value",
            "unit": "USD/pixel",
            "aggregation": "sum",
        },
        {
            "name": "carbon_preview.geojson",
            "type": "geojson",
            "map_default": True,
        },
        {
            "name": "dummy_output.txt",
            "type": "document",
            "map_default": False,
        },
    ],
}


def read_carbon_pool_codes(path: Path) -> tuple[set[str], list[str]]:
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames or []
        normalized_headers = {header.strip().lower(): header for header in headers}
        missing = sorted(REQUIRED_CARBON_COLUMNS - set(normalized_headers))
        if missing:
            return set(), missing

        lucode_field = normalized_headers["lucode"]
        codes = {
            normalize_code(row.get(lucode_field, ""))
            for row in reader
            if normalize_code(row.get(lucode_field, ""))
        }
    return codes, []


def check_inputs(
    inputs: dict,
    assets_dir: Path,
    read_asset_metadata: Callable[[Path], dict],
) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    info: list[str] = []
    details: dict = {}

    baseline_id = str(inputs.get("lulc_bas_asset_id") or "")
    carbon_pools_id = str(inputs.get("carbon_pools_asset_id") or "")
    calc_sequestration = bool(inputs.get("calc_sequestration", False))
    do_valuation = bool(inputs.get("do_valuation", False))
    alternate_id = str(inputs.get("lulc_alt_asset_id") or "")

    baseline_path = optional_asset_path(assets_dir, baseline_id)
    carbon_pools_path = optional_asset_path(assets_dir, carbon_pools_id)
    alternate_path = optional_asset_path(assets_dir, alternate_id)

    if not baseline_path:
        errors.append("Baseline LULC raster is required.")
    elif not baseline_path.exists():
        errors.append(f"Baseline LULC raster asset was not found: {baseline_id}")
    elif baseline_path.suffix.lower() not in {".tif", ".tiff"}:
        errors.append(f"Baseline LULC raster must be a GeoTIFF: {baseline_id}")

    if not carbon_pools_path:
        errors.append("Carbon pools CSV is required.")
    elif not carbon_pools_path.exists():
        errors.append(f"Carbon pools asset was not found: {carbon_pools_id}")
    elif carbon_pools_path.suffix.lower() != ".csv":
        errors.append(f"Carbon pools input must be a CSV file: {carbon_pools_id}")

    if do_valuation and not calc_sequestration:
        errors.append("Valuation requires Calculate sequestration to be enabled.")

    if calc_sequestration:
        if not alternate_path:
            errors.append("Alternate LULC raster is required when sequestration is enabled.")
        elif not alternate_path.exists():
            errors.append(f"Alternate LULC raster asset was not found: {alternate_id}")
        elif alternate_path.suffix.lower() not in {".tif", ".tiff"}:
            errors.append(f"Alternate LULC raster must be a GeoTIFF: {alternate_id}")
        elif baseline_path and baseline_path.exists() and alternate_path.resolve() == baseline_path.resolve():
            errors.append("Alternate LULC raster must be different from baseline LULC raster.")

    if do_valuation:
        valuation_fields = [
            ("lulc_bas_year", "Baseline LULC year"),
            ("lulc_alt_year", "Alternate LULC year"),
            ("price_per_metric_ton_of_c", "Price per metric ton of carbon"),
            ("discount_rate", "Annual discount rate"),
            ("rate_change", "Annual price change"),
        ]
        parsed_valuation: dict[str, float] = {}
        for key, label in valuation_fields:
            value = inputs.get(key)
            if value in ("", None):
                errors.append(f"{label} is required when valuation is enabled.")
                continue
            try:
                parsed_valuation[key] = float(value)
            except (TypeError, ValueError):
                errors.append(f"{label} must be numeric.")

        if "lulc_bas_year" in parsed_valuation:
            if not parsed_valuation["lulc_bas_year"].is_integer():
                errors.append("Baseline LULC year must be an integer year.")
        if "lulc_alt_year" in parsed_valuation:
            if not parsed_valuation["lulc_alt_year"].is_integer():
                errors.append("Alternate LULC year must be an integer year.")
        if {"lulc_bas_year", "lulc_alt_year"} <= set(parsed_valuation):
            if parsed_valuation["lulc_bas_year"] >= parsed_valuation["lulc_alt_year"]:
                errors.append("Alternate LULC year must be greater than baseline LULC year.")

        details["valuation"] = parsed_valuation

    if errors:
        return {
            "status": "error",
            "errors": errors,
            "warnings": warnings,
            "info": info,
            "details": details,
        }

    try:
        baseline_metadata = read_asset_metadata(baseline_path)
        details["baseline"] = {
            "crs": baseline_metadata.get("crs"),
            "bounds_wgs84": baseline_metadata.get("bounds_wgs84"),
            "width": baseline_metadata.get("width"),
            "height": baseline_metadata.get("height"),
        }
        if baseline_metadata.get("metadata_error"):
            errors.append(f"Baseline LULC raster could not be read: {baseline_metadata['metadata_error']}")
    except Exception as exc:
        errors.append(f"Baseline LULC raster could not be read: {exc}")

    try:
        pool_codes, missing_columns = read_carbon_pool_codes(carbon_pools_path)
        details["carbon_pool_codes_count"] = len(pool_codes)
        if missing_columns:
            errors.append(f"Carbon pools CSV is missing required columns: {', '.join(missing_columns)}")
    except Exception as exc:
        errors.append(f"Carbon pools CSV could not be read: {exc}")
        pool_codes = set()

    if not errors:
        try:
            lulc_codes = read_raster_codes(baseline_path)
            missing_pool_codes = sorted(lulc_codes - pool_codes, key=code_sort_key)
            unused_pool_codes = sorted(pool_codes - lulc_codes, key=code_sort_key)
            details["lulc_codes_count"] = len(lulc_codes)
            details["missing_pool_codes"] = missing_pool_codes[:50]
            details["unused_pool_codes"] = unused_pool_codes[:50]
            if missing_pool_codes:
                warnings.append(
                    f"{len(missing_pool_codes)} LULC code(s) are missing from carbon pools lucode values: "
                    f"{', '.join(missing_pool_codes[:12])}"
                )
            if unused_pool_codes:
                info.append(
                    f"{len(unused_pool_codes)} carbon pools lucode value(s) are not present in the baseline raster."
                )
        except Exception as exc:
            warnings.append(f"Could not compare baseline LULC codes with carbon pools lucode values: {exc}")

    if calc_sequestration and alternate_path and alternate_path.exists() and baseline_path and baseline_path.exists():
        try:
            warnings.extend(check_raster_pair_alignment(
                baseline_path,
                alternate_path,
                "Baseline",
                "alternate LULC",
            ))
        except Exception as exc:
            warnings.append(f"Could not compare baseline and alternate raster alignment: {exc}")

    if not errors and not warnings:
        info.append("Inputs passed basic Carbon checks.")

    return {
        "status": "error" if errors else "warning" if warnings else "ok",
        "errors": errors,
        "warnings": warnings,
        "info": info,
        "details": details,
    }


def validate_carbon_pools(path: Path) -> None:
    if not path.exists() or not path.is_file():
        raise ValueError(f"carbon pools asset does not exist: {path.name}")
    if path.suffix.lower() != ".csv":
        raise ValueError(f"carbon pools must be a CSV file, got: {path.name}")

    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.reader(handle)
        headers = next(reader, [])
    normalized = {header.strip().lower() for header in headers}
    missing = sorted(REQUIRED_CARBON_COLUMNS - normalized)
    if missing:
        raise ValueError(f"carbon pools CSV is missing required columns: {', '.join(missing)}")


def import_carbon_execute():
    candidates = [
        "natcap.invest.carbon",
        "natcap.invest.carbon.carbon",
    ]
    errors = []
    for module_name in candidates:
        try:
            module = importlib.import_module(module_name)
            execute_func = getattr(module, "execute", None)
            if callable(execute_func):
                return execute_func, module_name
            errors.append(f"{module_name} has no execute()")
        except Exception as exc:
            errors.append(f"{module_name}: {exc}")
    raise ImportError("; ".join(errors))


def validate_valuation_inputs(job_inputs: dict, calc_sequestration: bool) -> None:
    if not calc_sequestration:
        raise ValueError("valuation requires calc_sequestration to be true")
    required_valuation = [
        "lulc_bas_year",
        "lulc_alt_year",
        "price_per_metric_ton_of_c",
        "discount_rate",
        "rate_change",
    ]
    missing = [key for key in required_valuation if job_inputs.get(key) in ("", None)]
    if missing:
        raise ValueError(f"valuation inputs are missing: {', '.join(missing)}")

    bas_year = int(float(job_inputs["lulc_bas_year"]))
    alt_year = int(float(job_inputs["lulc_alt_year"]))
    if bas_year >= alt_year:
        raise ValueError("alternate LULC year must be greater than baseline LULC year")


def build_invest_args(
    job_inputs: dict,
    workspace_dir: Path,
    baseline_path: Path,
    carbon_pools_path: Path,
    alt_path: Path | None,
    calc_sequestration: bool,
    do_valuation: bool,
    results_suffix: str,
) -> dict:
    invest_args = {
        "workspace_dir": str(workspace_dir),
        "lulc_bas_path": str(baseline_path),
        "carbon_pools_path": str(carbon_pools_path),
        "calc_sequestration": calc_sequestration,
        "do_valuation": do_valuation,
        "results_suffix": results_suffix,
        "n_workers": int(job_inputs.get("n_workers", -1)),
    }
    if calc_sequestration and alt_path:
        invest_args["lulc_alt_path"] = str(alt_path)
    if do_valuation:
        invest_args.update({
            "lulc_bas_year": int(float(job_inputs["lulc_bas_year"])),
            "lulc_alt_year": int(float(job_inputs["lulc_alt_year"])),
            "price_per_metric_ton_of_c": float(job_inputs["price_per_metric_ton_of_c"]),
            "discount_rate": float(job_inputs["discount_rate"]),
            "rate_change": float(job_inputs["rate_change"]),
        })
    return invest_args


def write_stub_outputs(job_id: str, out_dir: Path, baseline_path: Path | None, results_suffix: str, handle) -> None:
    out_dir.mkdir(exist_ok=True)
    (out_dir / "dummy_output.txt").write_text(
        f"This is a development stub model output for job {job_id}",
        encoding="utf-8",
    )

    if baseline_path and baseline_path.exists() and baseline_path.suffix.lower() in SUPPORTED_RASTER_SUFFIXES:
        raster_name = f"carbon_output_{results_suffix}{baseline_path.suffix.lower()}"
        shutil.copy2(baseline_path, out_dir / raster_name)
        log(handle, f"wrote stub raster output: {raster_name}")

    (out_dir / "carbon_preview.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {
                            "model": "Carbon Storage and Sequestration",
                            "job_id": job_id,
                            "output": "carbon_preview",
                            "results_suffix": results_suffix,
                            "status": "stub",
                        },
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [
                                [
                                    [-88.5, 39.25],
                                    [-84.25, 39.25],
                                    [-84.25, 42.75],
                                    [-88.5, 42.75],
                                    [-88.5, 39.25],
                                ]
                            ],
                        },
                    }
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def run_job(
    job_id: str,
    job_inputs: dict,
    assets_dir: Path,
    workspace_dir: Path,
    outputs_dir: Path,
    run_mode: str,
    handle,
) -> None:
    results_suffix = str(job_inputs.get("results_suffix") or "mvp")
    calc_sequestration = bool(job_inputs.get("calc_sequestration", False))
    do_valuation = bool(job_inputs.get("do_valuation", False))

    baseline_asset_id = str(job_inputs.get("lulc_bas_asset_id") or "")
    carbon_pools_asset_id = str(job_inputs.get("carbon_pools_asset_id") or "")
    alt_asset_id = str(job_inputs.get("lulc_alt_asset_id") or "")

    baseline_path = safe_asset_path(assets_dir, baseline_asset_id) if baseline_asset_id else None
    carbon_pools_path = safe_asset_path(assets_dir, carbon_pools_asset_id) if carbon_pools_asset_id else None
    alt_path = safe_asset_path(assets_dir, alt_asset_id) if alt_asset_id else None

    log(handle, f"baseline asset: {baseline_asset_id or 'missing'}")
    log(handle, f"carbon pools asset: {carbon_pools_asset_id or 'missing'}")
    log(handle, f"alternate asset: {alt_asset_id or 'none'}")
    log(handle, f"calculate sequestration: {calc_sequestration}")
    log(handle, f"run valuation: {do_valuation}")
    log(handle, f"results suffix: {results_suffix}")

    if not baseline_path:
        raise ValueError("baseline LULC raster is required")
    if not carbon_pools_path:
        raise ValueError("carbon pools CSV is required")

    log(handle, "validating Carbon inputs")
    validate_raster(baseline_path, "baseline LULC raster")
    validate_carbon_pools(carbon_pools_path)
    if calc_sequestration:
        if not alt_path:
            raise ValueError("alternate LULC raster is required when calc_sequestration is true")
        validate_raster(alt_path, "alternate LULC raster")
    if do_valuation:
        validate_valuation_inputs(job_inputs, calc_sequestration)

    execute_func = None
    module_name = None
    try:
        execute_func, module_name = import_carbon_execute()
    except ImportError as exc:
        if run_mode == "real":
            raise RuntimeError(
                "natcap.invest Carbon execute() is not available. "
                "Install natcap.invest or set INVEST_RUNNER_MODE=auto for development stub output. "
                f"Import errors: {exc}"
            ) from exc
        log(handle, f"WARN: natcap.invest is not available; using development stub outputs. {exc}")

    if execute_func:
        workspace_dir.mkdir(parents=True, exist_ok=True)
        invest_args = build_invest_args(
            job_inputs,
            workspace_dir,
            baseline_path,
            carbon_pools_path,
            alt_path,
            calc_sequestration,
            do_valuation,
            results_suffix,
        )
        log(handle, f"running {module_name}.execute")
        execute_func(invest_args)
        log(handle, "InVEST Carbon execution completed")
        index_workspace_outputs(workspace_dir, outputs_dir, handle)
        return

    for i in range(5):
        log(handle, f"stub step {i + 1}/5: working...")
        time.sleep(0.5)
    write_stub_outputs(job_id, outputs_dir, baseline_path, results_suffix, handle)


def execute(args: dict):
    """Legacy lightweight stub retained for local imports.

    The production runner in backend/run_job.py calls natcap.invest directly.
    """
    workspace = Path(args.get("workspace_dir", "."))
    workspace = workspace if isinstance(workspace, Path) else Path(workspace)
    workspace.mkdir(parents=True, exist_ok=True)
    log = workspace / "carbon_stub.log"
    with log.open("a", encoding="utf-8") as f:
        f.write("Carbon model stub start\n")
        f.flush()
        for i in range(3):
            f.write(f"running step {i + 1}\n")
            f.flush()
            time.sleep(1)
        out = workspace / "total_carbon.tif"
        out.write_text("DUMMY TIF CONTENT\n")
        f.write("Carbon model stub finished\n")
    return {"status": "succeeded", "workspace": str(workspace)}
