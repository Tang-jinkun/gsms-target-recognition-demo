"""Freeze and verify immutable inputs for snapshot-backed model jobs."""
from __future__ import annotations

import hashlib
import shutil
from datetime import datetime, timezone
from pathlib import Path


def file_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def freeze_snapshot_inputs(
    job_dir: Path,
    source_dir: Path,
    inputs: dict,
    asset_fingerprints: dict,
) -> tuple[dict, dict]:
    if not asset_fingerprints:
        raise ValueError("Snapshot-backed jobs require asset fingerprints.")
    source_root = source_dir.resolve()
    inputs_dir = job_dir / "inputs"
    inputs_dir.mkdir(parents=True, exist_ok=False)
    try:
        frozen_inputs = dict(inputs)
        manifest_assets = []
        replacements = {}
        used_names = set()
        for asset_id, fingerprint in sorted(asset_fingerprints.items()):
            source_name = Path(str(fingerprint.get("path") or "")).name
            source = (source_root / source_name).resolve()
            expected_hash = str(fingerprint.get("sha256") or "")
            if (
                not source_name
                or source_root not in source.parents
                or not expected_hash
                or not source.exists()
                or not source.is_file()
            ):
                raise ValueError(f"Validated input asset is unavailable: {asset_id}")
            if file_sha256(source) != expected_hash:
                raise ValueError(f"Validated input asset changed before freezing: {asset_id}")
            frozen_name = source_name
            if frozen_name in used_names:
                frozen_name = f"{asset_id}{source.suffix}"
            used_names.add(frozen_name)
            frozen = inputs_dir / frozen_name
            shutil.copy2(source, frozen)
            if file_sha256(frozen) != expected_hash:
                raise ValueError(f"Frozen input verification failed: {asset_id}")
            try:
                frozen.chmod(0o444)
            except OSError:
                pass
            replacements[source_name] = frozen_name
            replacements[str(fingerprint.get("path"))] = frozen_name
            manifest_assets.append({
                "asset_id": asset_id,
                "source_path": str(fingerprint.get("path")),
                "frozen_path": f"inputs/{frozen_name}",
                "size": frozen.stat().st_size,
                "sha256": expected_hash,
            })
        for key, value in frozen_inputs.items():
            if isinstance(value, str) and value in replacements:
                frozen_inputs[key] = replacements[value]
        return frozen_inputs, {
            "version": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "assets": manifest_assets,
        }
    except Exception:
        shutil.rmtree(inputs_dir, ignore_errors=True)
        raise


def verify_input_manifest(manifest: dict, assets_dir: Path) -> None:
    root = assets_dir.resolve()
    for asset in manifest.get("assets", []):
        frozen_name = Path(str(asset.get("frozen_path") or "")).name
        path = (root / frozen_name).resolve()
        if root not in path.parents or not path.exists() or not path.is_file():
            raise ValueError(f"Frozen input is missing: {asset.get('asset_id')}")
        if file_sha256(path) != asset.get("sha256"):
            raise ValueError(f"Frozen input hash mismatch: {asset.get('asset_id')}")
