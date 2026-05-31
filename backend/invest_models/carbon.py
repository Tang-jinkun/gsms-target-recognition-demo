import csv
import logging
import time
from pathlib import Path
from typing import Callable

logger = logging.getLogger("invest.carbon")

REQUIRED_CARBON_COLUMNS = {"lucode", "c_above", "c_below", "c_soil", "c_dead"}

MODEL_SCHEMA = {
    "id": "carbon",
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
    "outputs": [
        {
            "name": "c_storage_bas_{results_suffix}.tif",
            "type": "raster",
            "map_default": True,
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


def normalize_code(value) -> str:
    text = str(value).strip()
    if not text:
        return text
    try:
        as_float = float(text)
        if as_float.is_integer():
            return str(int(as_float))
    except Exception:
        pass
    return text


def code_sort_key(value: str) -> tuple[int, int | str]:
    return (0, int(value)) if value.isdigit() else (1, value)


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


def read_raster_codes(path: Path, max_size: int = 2048) -> set[str]:
    import numpy as np
    import rasterio
    from rasterio.enums import Resampling

    with rasterio.open(path) as dataset:
        scale = min(max_size / dataset.width, max_size / dataset.height, 1.0)
        out_width = max(1, int(dataset.width * scale))
        out_height = max(1, int(dataset.height * scale))
        data = dataset.read(
            1,
            out_shape=(out_height, out_width),
            resampling=Resampling.nearest,
            masked=True,
        )
        values = np.ma.compressed(data)
        if values.size == 0:
            return set()
        unique_values = np.unique(values)
        return {normalize_code(value) for value in unique_values.tolist()}


def check_raster_pair_alignment(baseline_path: Path, alternate_path: Path) -> list[str]:
    import rasterio

    warnings: list[str] = []
    with rasterio.open(baseline_path) as baseline, rasterio.open(alternate_path) as alternate:
        if baseline.crs != alternate.crs:
            warnings.append("Baseline and alternate LULC rasters use different CRS values.")
        if baseline.width != alternate.width or baseline.height != alternate.height:
            warnings.append("Baseline and alternate LULC rasters have different dimensions.")
        if baseline.transform != alternate.transform:
            warnings.append("Baseline and alternate LULC rasters have different geotransforms.")
    return warnings


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

    baseline_path = assets_dir / Path(baseline_id).name if baseline_id else None
    carbon_pools_path = assets_dir / Path(carbon_pools_id).name if carbon_pools_id else None
    alternate_path = assets_dir / Path(alternate_id).name if alternate_id else None

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
            warnings.extend(check_raster_pair_alignment(baseline_path, alternate_path))
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
