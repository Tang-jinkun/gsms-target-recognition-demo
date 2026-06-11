from __future__ import annotations

import json
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import files_util
from app.db import get_db
from app.matching import resolve_data_file
from app.models import DataFile, Feature, Scene, SceneImport
from app.routers.data import ensure_agent_outputs_folder, wb_file_dict
from app.storage import project_files_dir
from app.target_recognition import (
    analysis_context_id,
    execute_target_query,
    source_fingerprint,
    validate_conditions,
)

router = APIRouter(prefix="/api/target-recognition", tags=["target-recognition"])


class TargetConditionIn(BaseModel):
    field: str = Field(min_length=1)
    operator: str = Field(min_length=1)
    value: str | int | float | bool | list[str | int | float | bool]


class TargetQueryIn(BaseModel):
    sceneId: str
    sourceAssetIds: list[str] = Field(min_length=1)
    targetDescription: str = Field(min_length=1)
    conditions: list[TargetConditionIn] = Field(min_length=1)


@router.get("/scenes/{scene_id}/vector-profiles")
def list_vector_profiles(scene_id: str, db: Session = Depends(get_db)):
    if not db.get(Scene, scene_id):
        raise HTTPException(status_code=404, detail="Scene not found")
    rows = (
        db.query(DataFile)
        .join(SceneImport, SceneImport.file_id == DataFile.id)
        .filter(SceneImport.scene_id == scene_id, DataFile.file_type == "geojson")
        .all()
    )
    candidates = []
    for data_file in rows:
        if (data_file.extra_meta or {}).get("origin") == "target-recognition":
            continue
        path = resolve_data_file(data_file)
        metadata = files_util.read_file_metadata(path)
        candidates.append({
            "assetId": data_file.id,
            "filename": data_file.name,
            "profile": metadata.get("vector_property_profile"),
            "bounds": metadata.get("bounds_wgs84") or metadata.get("bounds"),
            "fingerprint": source_fingerprint(path),
        })
    return {"sceneId": scene_id, "candidates": candidates}


@router.post("/queries", status_code=201)
def run_target_query(body: TargetQueryIn, db: Session = Depends(get_db)):
    if not db.get(Scene, body.sceneId):
        raise HTTPException(status_code=404, detail="Scene not found")
    asset_ids = list(dict.fromkeys(body.sourceAssetIds))
    rows = (
        db.query(DataFile)
        .join(SceneImport, SceneImport.file_id == DataFile.id)
        .filter(SceneImport.scene_id == body.sceneId, DataFile.id.in_(asset_ids))
        .all()
    )
    by_id = {row.id: row for row in rows}
    missing = [asset_id for asset_id in asset_ids if asset_id not in by_id]
    if missing:
        raise HTTPException(status_code=400, detail=f"Assets are not imported into the scene: {missing}")
    if any(row.file_type != "geojson" for row in rows):
        raise HTTPException(status_code=400, detail="Target recognition supports GeoJSON sources only")

    sources, fingerprints, all_fields = [], {}, {}
    for asset_id in asset_ids:
        path = resolve_data_file(by_id[asset_id])
        metadata = files_util.read_file_metadata(path)
        sources.append((asset_id, path))
        fingerprints[asset_id] = source_fingerprint(path)
        for field in (metadata.get("vector_property_profile") or {}).get("fields", []):
            previous = all_fields.get(field["name"])
            if previous and previous.get("inferred_type") != field.get("inferred_type"):
                previous["inferred_type"] = "mixed"
            else:
                all_fields[field["name"]] = dict(field)
    try:
        conditions = validate_conditions(list(all_fields.values()), [item.model_dump() for item in body.conditions])
        result = execute_target_query(sources, conditions)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    context_id = analysis_context_id(body.sceneId, fingerprints, conditions)
    folder = ensure_agent_outputs_folder(db)
    output_name = f"target-result-{context_id[:12]}.geojson"
    stored_name = f"{body.sceneId}-{context_id}-{output_name}"
    destination = project_files_dir() / stored_name
    destination.write_text(json.dumps(result["geojson"], ensure_ascii=False, indent=2), encoding="utf-8")
    metadata = files_util.read_file_metadata(destination)
    extra = {
        "origin": "target-recognition",
        "scene_id": body.sceneId,
        "analysis_context_id": context_id,
        "source_asset_ids": asset_ids,
        "target_description": body.targetDescription,
        "conditions": conditions,
        **{key: value for key, value in metadata.items() if key not in {"name", "file_type", "file_format", "size", "crs", "bounds", "bounds_wgs84"}},
    }
    data_file = db.query(DataFile).filter(DataFile.path == stored_name).first()
    if not data_file:
        data_file = DataFile(
            id=uuid.uuid4().hex,
            name=output_name,
            file_type="geojson",
            file_format="geojson",
            size=destination.stat().st_size,
            path=stored_name,
            folder_id=folder.id,
            crs=metadata.get("crs"),
            bounds=metadata.get("bounds"),
            bounds_wgs84=metadata.get("bounds_wgs84"),
            extra_meta=extra,
        )
        db.add(data_file)
        db.flush()
    else:
        data_file.name = output_name
        data_file.file_type = "geojson"
        data_file.file_format = "geojson"
        data_file.size = destination.stat().st_size
        data_file.folder_id = folder.id
        data_file.crs = metadata.get("crs")
        data_file.bounds = metadata.get("bounds")
        data_file.bounds_wgs84 = metadata.get("bounds_wgs84")
        data_file.extra_meta = extra
    if not db.get(SceneImport, {"scene_id": body.sceneId, "file_id": data_file.id}):
        db.add(SceneImport(scene_id=body.sceneId, file_id=data_file.id))
    db.commit()
    db.refresh(data_file)
    try:
        db.query(Feature).filter(Feature.file_id == data_file.id).delete(synchronize_session=False)
        db.commit()
        files_util.ingest_vector_features(destination, data_file.id, db)
    except Exception:
        db.rollback()
        pass

    result.pop("geojson")
    return {
        "analysisContextId": context_id,
        "sceneId": body.sceneId,
        "sourceAssetIds": asset_ids,
        "targetDescription": body.targetDescription,
        "conditions": conditions,
        **result,
        "outputAsset": wb_file_dict(data_file),
        "outputFingerprint": files_util.file_sha256(destination),
    }
