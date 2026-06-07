"""Deterministic data facts exposed to the agent matching layer."""
from __future__ import annotations

import csv
import json
import hashlib
from pathlib import Path
from typing import TYPE_CHECKING, Iterable

from app.files_util import read_file_metadata
from app.job_inputs import file_sha256
from app.storage import project_files_dir
from invest_models.common import code_sort_key, normalize_code, read_raster_codes

if TYPE_CHECKING:
    from app.models import DataFile


def resolve_data_file(data_file: "DataFile") -> Path:
    path = (project_files_dir() / Path(data_file.path).name).resolve()
    root = project_files_dir().resolve()
    if root not in path.parents or not path.exists() or not path.is_file():
        raise FileNotFoundError(data_file.id)
    return path


def build_data_card(data_file: "DataFile") -> dict:
    path = resolve_data_file(data_file)
    metadata = read_file_metadata(path)
    extra = data_file.extra_meta or {}
    hints = [value for value in [extra.get("note"), extra.get("semantic_role")] if value]
    card = {
        "asset_id": data_file.id,
        "path": data_file.path,
        "filename": data_file.name,
        "asset_type": data_file.file_type,
        "file_format": data_file.file_format,
        "semantic_hints": hints,
        "metadata": metadata,
        "provenance": {
            "source": extra.get("source", "user-local"),
            "size": data_file.size,
            "updated_at": data_file.updated_at.isoformat() if data_file.updated_at else None,
        },
    }
    return card


def build_asset_fingerprints(
    binding_report: dict,
    data_files: dict[str, "DataFile"],
) -> dict[str, dict]:
    fingerprints = {}
    for binding in binding_report.get("bindings", []):
        if binding.get("status") != "matched":
            continue
        asset_id = binding.get("selectedAssetId")
        if not asset_id:
            continue
        data_file = data_files.get(asset_id)
        if not data_file:
            raise ValueError(f"Selected asset is not imported into the scene: {asset_id}")
        path = resolve_data_file(data_file)
        stat = path.stat()
        fingerprints[asset_id] = {
            "path": data_file.path,
            "size": stat.st_size,
            "sha256": file_sha256(path),
        }
    return fingerprints


def changed_asset_fingerprints(
    expected: dict[str, dict],
    data_files: dict[str, "DataFile"],
) -> list[str]:
    changed = []
    for asset_id, fingerprint in expected.items():
        data_file = data_files.get(asset_id)
        if not data_file:
            changed.append(asset_id)
            continue
        try:
            path = resolve_data_file(data_file)
            stat = path.stat()
            if (
                data_file.path != fingerprint.get("path")
                or stat.st_size != fingerprint.get("size")
                or file_sha256(path) != fingerprint.get("sha256")
            ):
                changed.append(asset_id)
        except (FileNotFoundError, OSError):
            changed.append(asset_id)
    return sorted(changed)


def read_csv_column_values(path: Path, field: str) -> set[str]:
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = {str(name).strip().lower(): name for name in reader.fieldnames or []}
        source_field = fields.get(field.strip().lower())
        if not source_field:
            raise ValueError(f"CSV field not found: {field}")
        return {
            normalize_code(row.get(source_field, ""))
            for row in reader
            if normalize_code(row.get(source_field, ""))
        }


def check_code_coverage_values(
    raster_values: Iterable[object],
    table_values: Iterable[object],
) -> dict:
    raster_codes = {normalize_code(value) for value in raster_values if normalize_code(value)}
    table_codes = {normalize_code(value) for value in table_values if normalize_code(value)}
    missing = sorted(raster_codes - table_codes, key=code_sort_key)
    return {
        "status": "failed" if missing else "passed",
        "facts": [
            f"Compared {len(raster_codes)} raster codes with {len(table_codes)} table codes."
        ],
        "missing_values": missing,
    }


def check_code_coverage(raster_path: Path, table_path: Path, field: str) -> dict:
    result = check_code_coverage_values(
        read_raster_codes(raster_path),
        read_csv_column_values(table_path, field),
    )
    return {
        "kind": "code-coverage",
        "field": field,
        **result,
    }


def build_model_inputs_from_bindings(
    model_schema: dict,
    binding_report: dict,
    asset_filenames: dict[str, str],
    parameters: dict | None = None,
) -> dict:
    if binding_report.get("recommendedNextAction") != "proceed-to-validation":
        raise ValueError("Binding Report is not ready to proceed to validation.")
    if binding_report.get("conflicts"):
        raise ValueError("Binding Report contains unresolved conflicts.")
    if binding_report.get("unresolvedQuestions"):
        raise ValueError("Binding Report contains unresolved questions.")

    by_invest_arg = {
        item.get("invest_arg"): item
        for item in model_schema.get("inputs", [])
        if item.get("invest_arg")
    }
    input_schemas = {item.get("id"): item for item in model_schema.get("inputs", [])}
    inputs = dict(parameters or {})
    asset_parameters = sorted(
        key for key in inputs
        if input_schemas.get(key, {}).get("kind") == "asset"
    )
    if asset_parameters:
        raise ValueError(
            f"Asset inputs must come from Binding Report selections: {', '.join(asset_parameters)}"
        )
    for binding in binding_report.get("bindings", []):
        slot = binding.get("slot")
        if slot not in by_invest_arg:
            raise ValueError(f"Unknown model input slot: {slot}")
        if binding.get("status") != "matched":
            continue
        asset_id = binding.get("selectedAssetId")
        if not asset_id:
            raise ValueError(f"Matched slot has no selected asset: {slot}")
        if asset_id not in asset_filenames:
            raise ValueError(f"Selected asset is not imported into the scene: {asset_id}")
        input_schema = by_invest_arg[slot]
        if input_schema.get("kind") != "asset":
            raise ValueError(f"Binding Report cannot bind a non-asset input: {slot}")
        inputs[input_schema["id"]] = asset_filenames[asset_id]

    for item in model_schema.get("inputs", []):
        if item.get("required") and item.get("kind") == "asset" and not inputs.get(item.get("id")):
            raise ValueError(f"Required asset input is not bound: {item.get('invest_arg') or item.get('id')}")

    known_input_ids = {item.get("id") for item in model_schema.get("inputs", [])}
    unknown_parameters = sorted(set(inputs) - known_input_ids)
    if unknown_parameters:
        raise ValueError(f"Unknown model parameters: {', '.join(unknown_parameters)}")
    return inputs


def validation_snapshot_id(
    model_id: str,
    scene_id: str,
    inputs: dict,
    asset_fingerprints: dict | None = None,
) -> str:
    payload = json.dumps(
        {
            "model_id": model_id,
            "scene_id": scene_id,
            "inputs": inputs,
            "asset_fingerprints": asset_fingerprints or {},
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def next_snapshot_status(current: str, action: str, can_proceed: bool) -> str:
    if action == "confirm":
        if not can_proceed:
            raise ValueError("A failed validation snapshot cannot be confirmed.")
        if current not in {"awaiting_confirmation", "confirmed"}:
            raise ValueError(f"A {current} validation snapshot cannot be confirmed.")
        return "confirmed"
    if action == "reject":
        if current == "consumed":
            raise ValueError("A consumed validation snapshot cannot be rejected.")
        return "rejected"
    if action == "consume":
        if current != "confirmed" or not can_proceed:
            raise ValueError("Only a confirmed passing validation snapshot can create a job.")
        return "consumed"
    if action == "invalidate":
        if current == "consumed":
            raise ValueError("A consumed validation snapshot cannot be invalidated.")
        return "invalidated"
    raise ValueError(f"Unknown validation snapshot action: {action}")
