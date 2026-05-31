import csv
import shutil
from pathlib import Path

SUPPORTED_RASTER_SUFFIXES = {".tif", ".tiff"}
SUPPORTED_TABLE_SUFFIXES = {".csv"}
SUPPORTED_VECTOR_SUFFIXES = {".geojson", ".json", ".zip"}
COPY_OUTPUT_SUFFIXES = {".tif", ".tiff", ".csv", ".html", ".htm", ".txt", ".json", ".geojson"}


def safe_asset_path(assets_dir: Path, asset_id: str) -> Path:
    safe_name = Path(str(asset_id)).name
    return assets_dir / safe_name


def optional_asset_path(assets_dir: Path, asset_id: str) -> Path | None:
    return assets_dir / Path(asset_id).name if asset_id else None


def log(handle, message: str) -> None:
    handle.write(f"{message}\n")
    handle.flush()


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


def read_csv_headers(path: Path) -> list[str]:
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.reader(handle)
        return next(reader, [])


def normalized_csv_headers(path: Path) -> dict[str, str]:
    return {header.strip().lower(): header for header in read_csv_headers(path)}


def require_asset(
    errors: list[str],
    assets_dir: Path,
    asset_id: str,
    label: str,
    suffixes: set[str],
) -> Path | None:
    path = optional_asset_path(assets_dir, asset_id)
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


def validate_raster(path: Path, label: str) -> None:
    if not path.exists() or not path.is_file():
        raise ValueError(f"{label} asset does not exist: {path.name}")
    if path.suffix.lower() not in SUPPORTED_RASTER_SUFFIXES:
        raise ValueError(f"{label} must be a GeoTIFF, got: {path.name}")

    try:
        import rasterio

        with rasterio.open(path) as dataset:
            if dataset.width <= 0 or dataset.height <= 0 or dataset.count <= 0:
                raise ValueError(f"{label} is not a readable raster: {path.name}")
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"{label} could not be read as GeoTIFF: {exc}") from exc


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


def check_raster_pair_alignment(
    reference_path: Path,
    comparison_path: Path,
    reference_label: str = "Reference",
    comparison_label: str = "Comparison",
) -> list[str]:
    import rasterio

    warnings: list[str] = []
    with rasterio.open(reference_path) as reference, rasterio.open(comparison_path) as comparison:
        if reference.crs != comparison.crs:
            warnings.append(f"{reference_label} and {comparison_label} rasters use different CRS values.")
        if reference.width != comparison.width or reference.height != comparison.height:
            warnings.append(f"{reference_label} and {comparison_label} rasters have different dimensions.")
        if reference.transform != comparison.transform:
            warnings.append(f"{reference_label} and {comparison_label} rasters have different geotransforms.")
    return warnings


def index_workspace_outputs(workspace_dir: Path, outputs_dir: Path, handle) -> None:
    outputs_dir.mkdir(exist_ok=True)
    copied = 0
    for path in workspace_dir.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in COPY_OUTPUT_SUFFIXES:
            continue
        dest = outputs_dir / path.name
        if dest.exists():
            dest = outputs_dir / f"{path.stem}.{copied}{path.suffix}"
        shutil.copy2(path, dest)
        copied += 1
    log(handle, f"indexed {copied} workspace output files")
