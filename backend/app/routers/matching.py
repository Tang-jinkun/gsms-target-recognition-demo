"""Agent-facing read-only APIs for data matching facts."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db import get_db
from app import files_util
from app.matching import (
    build_data_card,
    build_asset_fingerprints,
    build_model_inputs_from_bindings,
    changed_asset_fingerprints,
    check_code_coverage,
    resolve_data_file,
    next_snapshot_status,
    validation_snapshot_id,
)
from app.models import DataFile, Job, Scene, SceneImport, ValidationSnapshot
from app.routers.jobs import create_scene_job_record
from app.storage import project_files_dir
from invest_models.registry import check_model_inputs, get_model_schema

router = APIRouter(prefix="/api", tags=["matching"])


class RelationCheckIn(BaseModel):
    kind: str
    left_asset_id: str
    right_asset_id: str
    field: str = "lucode"


class ValidateBindingsIn(BaseModel):
    scene_id: str
    binding_report: dict
    parameters: dict = Field(default_factory=dict)


class ConfirmSnapshotIn(BaseModel):
    confirmed: bool


class SnapshotJobIn(BaseModel):
    run_mode: str = "real"


class DataHubDiscoveryIn(BaseModel):
    scene_id: str
    model_id: str
    query: str = ""
    folder_id: str | None = None
    study_area_bounds: list[float] | None = None
    limit_per_slot: int = Field(default=3, ge=1, le=10)


class DataHubImportIn(BaseModel):
    scene_id: str
    file_ids: list[str]


def _snapshot_dict(snapshot: ValidationSnapshot) -> dict:
    return {
        "snapshot_id": snapshot.id,
        "scene_id": snapshot.scene_id,
        "model_id": snapshot.model_id,
        "status": snapshot.status,
        "can_proceed": snapshot.can_proceed,
        "inputs": snapshot.inputs,
        "validation": snapshot.validation,
        "asset_fingerprints": snapshot.asset_fingerprints,
        "created_at": snapshot.created_at.isoformat() if snapshot.created_at else None,
        "confirmed_at": snapshot.confirmed_at.isoformat() if snapshot.confirmed_at else None,
        "rejected_at": snapshot.rejected_at.isoformat() if snapshot.rejected_at else None,
        "consumed_at": snapshot.consumed_at.isoformat() if snapshot.consumed_at else None,
        "job_id": snapshot.job.id if snapshot.job else None,
    }


def _asset_type_for_slot(input_schema: dict) -> str | None:
    if input_schema.get("kind") != "asset":
        return None
    asset_type = input_schema.get("asset_type")
    if asset_type == "table":
        return "table"
    if asset_type in {"raster", "geojson", "vector"}:
        return "geojson" if asset_type == "vector" else asset_type
    return str(asset_type) if asset_type else None


def _search_text(data_file: DataFile) -> str:
    extra = data_file.extra_meta or {}
    folder_name = data_file.folder.name if data_file.folder else ""
    values = [
        data_file.name,
        data_file.file_type,
        data_file.file_format,
        folder_name,
        extra.get("note"),
        extra.get("semantic_role"),
        extra.get("source"),
    ]
    return " ".join(str(value).lower() for value in values if value)


def _terms(value: str) -> list[str]:
    return [
        term
        for term in Path(value).stem.lower().replace("_", " ").replace("-", " ").split()
        if len(term) > 1
    ]


def _columns(data_file: DataFile) -> set[str]:
    extra = data_file.extra_meta or {}
    columns = extra.get("columns") or extra.get("fields") or []
    if isinstance(columns, list):
        return {
            str(column.get("name", column) if isinstance(column, dict) else column).strip().lower()
            for column in columns
            if str(column.get("name", column) if isinstance(column, dict) else column).strip()
        }
    return set()


def _bounds_overlap(left: list[float] | None, right: list[float] | None) -> bool:
    if not left or not right or len(left) != 4 or len(right) != 4:
        return False
    return not (left[2] < right[0] or right[2] < left[0] or left[3] < right[1] or right[3] < left[1])


def _candidate_summary(data_file: DataFile) -> dict:
    extra = data_file.extra_meta or {}
    return {
        "file_id": data_file.id,
        "name": data_file.name,
        "folder_id": data_file.folder_id,
        "folder_name": data_file.folder.name if data_file.folder else None,
        "file_type": data_file.file_type,
        "file_format": data_file.file_format,
        "size": data_file.size,
        "crs": data_file.crs,
        "bounds": data_file.bounds_wgs84 or data_file.bounds,
        "columns": sorted(_columns(data_file)),
        "row_count": extra.get("row_count"),
        "band_count": extra.get("band_count"),
        "note": extra.get("note", ""),
    }


def _score_data_hub_candidate(
    data_file: DataFile,
    input_schema: dict,
    scene_bounds: list[float] | None,
    already_imported: bool,
) -> dict:
    expected_type = _asset_type_for_slot(input_schema)
    reasons: list[str] = []
    risks: list[str] = []
    rejected_reasons: list[str] = []
    score = 0.0

    if expected_type and data_file.file_type != expected_type:
        rejected_reasons.append(f"Expected {expected_type}, found {data_file.file_type}.")
    else:
        score += 0.45
        reasons.append(f"File type {data_file.file_type} matches the slot asset type.")

    required_fields = [str(field).lower() for field in input_schema.get("required_fields", [])]
    if required_fields:
        fields = _columns(data_file)
        missing = [field for field in required_fields if field not in fields]
        if missing:
            rejected_reasons.append(f"Missing required fields: {', '.join(missing)}.")
        else:
            score += 0.35
            reasons.append(f"Contains required fields: {', '.join(required_fields)}.")

    search_text = _search_text(data_file)
    semantic_terms = [str(term).lower() for term in input_schema.get("semantic_terms", [])]
    matched_terms = [
        term for term in semantic_terms
        if any(token in search_text for token in _terms(term))
    ]
    if matched_terms:
        score += min(0.18, 0.045 * len(matched_terms))
        reasons.append(f"Name or metadata matches semantic terms: {', '.join(matched_terms[:4])}.")

    bounds = data_file.bounds_wgs84 or data_file.bounds
    if scene_bounds and data_file.file_type in {"raster", "geojson"}:
        if _bounds_overlap(bounds, scene_bounds):
            score += 0.08
            reasons.append("Spatial bounds overlap the supplied study-area bounds.")
        elif bounds:
            risks.append("Spatial bounds do not overlap the supplied study-area bounds.")
    elif data_file.file_type in {"raster", "geojson"} and not bounds:
        risks.append("Spatial bounds are unavailable, so spatial fit was not scored.")

    if already_imported:
        risks.append("Already imported into this scene; import will skip this file.")

    score = 0.0 if rejected_reasons else min(1.0, score)
    return {
        **_candidate_summary(data_file),
        "score": round(score, 3),
        "confidence": "high" if score >= 0.8 else "medium" if score >= 0.55 else "low",
        "reasons": reasons,
        "risks": risks,
        "rejected": bool(rejected_reasons),
        "rejection_reasons": rejected_reasons,
        "already_imported": already_imported,
    }


@router.get("/scenes/{scene_id}/data-cards")
def list_scene_data_cards(scene_id: str, db: Session = Depends(get_db)):
    if not db.get(Scene, scene_id):
        raise HTTPException(status_code=404, detail="Scene not found")
    rows = (
        db.query(DataFile)
        .join(SceneImport, SceneImport.file_id == DataFile.id)
        .filter(SceneImport.scene_id == scene_id)
        .order_by(SceneImport.imported_at.desc())
        .all()
    )
    cards, diagnostics = [], []
    for data_file in rows:
        try:
            cards.append(build_data_card(data_file))
        except Exception as exc:
            diagnostics.append({
                "asset_id": data_file.id,
                "severity": "error",
                "message": str(exc),
            })
    return {"scene_id": scene_id, "data_cards": cards, "diagnostics": diagnostics}


@router.post("/matching/data-hub/discover")
def discover_data_hub_candidates(body: DataHubDiscoveryIn, db: Session = Depends(get_db)):
    if not db.get(Scene, body.scene_id):
        raise HTTPException(status_code=404, detail="Scene not found")
    model_schema = get_model_schema(body.model_id)
    if not model_schema:
        raise HTTPException(status_code=404, detail="Model not found")

    imported_ids = {
        row.file_id
        for row in db.query(SceneImport).filter(SceneImport.scene_id == body.scene_id).all()
    }
    required_asset_inputs = [
        item for item in model_schema.get("inputs", [])
        if item.get("kind") == "asset" and item.get("required") is True and item.get("invest_arg")
    ]
    slots = []
    query_text = body.query.strip().lower()
    total_examined = 0
    total_rejected = 0
    needs_narrowing = False

    for input_schema in required_asset_inputs:
        expected_type = _asset_type_for_slot(input_schema)
        query = db.query(DataFile)
        if expected_type:
            query = query.filter(DataFile.file_type == expected_type)
        if body.folder_id:
            query = query.filter(DataFile.folder_id == body.folder_id)
        if query_text:
            query = query.filter(or_(
                DataFile.name.ilike(f"%{query_text}%"),
                DataFile.file_format.ilike(f"%{query_text}%"),
            ))
        rows = query.order_by(DataFile.updated_at.desc()).limit(50).all()
        total_examined += len(rows)
        if len(rows) >= 50:
            needs_narrowing = True
        scored = [
            _score_data_hub_candidate(
                data_file,
                input_schema,
                body.study_area_bounds,
                data_file.id in imported_ids,
            )
            for data_file in rows
        ]
        rejected = [item for item in scored if item["rejected"]]
        total_rejected += len(rejected)
        candidates = [
            item for item in scored
            if not item["rejected"] and not item["already_imported"]
        ]
        candidates.sort(key=lambda item: (-item["score"], item["name"], item["file_id"]))
        top_candidates = candidates[:body.limit_per_slot]
        ambiguity = (
            len(top_candidates) > 1
            and top_candidates[0]["score"] - top_candidates[1]["score"] < 0.08
        )
        slots.append({
            "slot": input_schema.get("invest_arg"),
            "input_id": input_schema.get("id"),
            "label": input_schema.get("label") or input_schema.get("invest_arg"),
            "asset_type": expected_type,
            "required": True,
            "required_fields": input_schema.get("required_fields", []),
            "candidates": top_candidates,
            "excluded": rejected[:5],
            "missing": len(top_candidates) == 0,
            "ambiguous": ambiguity,
            "diagnostics": (
                ["Multiple candidates have close scores; ask the user which file to import."]
                if ambiguity else []
            ),
        })

    recommended_file_ids = []
    for slot in slots:
        candidates = slot["candidates"]
        if candidates and not slot["ambiguous"]:
            recommended_file_ids.append(candidates[0]["file_id"])
    recommended_file_ids = list(dict.fromkeys(recommended_file_ids))
    missing_slots = [slot["slot"] for slot in slots if slot["missing"]]
    ambiguous_slots = [slot["slot"] for slot in slots if slot["ambiguous"]]
    return {
        "scene_id": body.scene_id,
        "model_id": body.model_id,
        "strategy": "recommend-after-confirmation",
        "limits": {
            "prefilter_per_slot": 50,
            "final_per_slot": body.limit_per_slot,
        },
        "needs_narrowing": needs_narrowing,
        "slots": slots,
        "recommended_file_ids": recommended_file_ids,
        "missing_slots": missing_slots,
        "ambiguous_slots": ambiguous_slots,
        "summary": {
            "examined": total_examined,
            "rejected": total_rejected,
            "recommendation_count": len(recommended_file_ids),
        },
        "next_action": (
            "ask-user-to-narrow-search"
            if needs_narrowing and not recommended_file_ids
            else "ask-user-to-confirm-import"
        ),
    }


@router.post("/matching/data-hub/import", status_code=201)
def import_data_hub_files_to_scene(body: DataHubImportIn, db: Session = Depends(get_db)):
    if not db.get(Scene, body.scene_id):
        raise HTTPException(status_code=404, detail="Scene not found")
    file_ids = list(dict.fromkeys(body.file_ids))
    added = 0
    skipped: list[str] = []
    missing: list[str] = []
    for file_id in file_ids:
        if not db.get(DataFile, file_id):
            missing.append(file_id)
            continue
        exists = db.get(SceneImport, {"scene_id": body.scene_id, "file_id": file_id})
        if exists:
            skipped.append(file_id)
            continue
        db.add(SceneImport(scene_id=body.scene_id, file_id=file_id))
        added += 1
    db.commit()
    return {
        "scene_id": body.scene_id,
        "imported": added,
        "skipped_existing": skipped,
        "missing_file_ids": missing,
        "file_ids": file_ids,
    }


@router.post("/matching/check-relation")
def check_relation(body: RelationCheckIn, db: Session = Depends(get_db)):
    if body.kind != "code-coverage":
        raise HTTPException(status_code=400, detail=f"Unsupported relation kind: {body.kind}")
    left = db.get(DataFile, body.left_asset_id)
    right = db.get(DataFile, body.right_asset_id)
    if not left or not right:
        raise HTTPException(status_code=404, detail="Relation asset not found")
    try:
        result = check_code_coverage(
            resolve_data_file(left),
            resolve_data_file(right),
            body.field,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "id": f"{body.kind}:{left.id}:{right.id}:{body.field}",
        "left_asset_id": left.id,
        "right_asset_id": right.id,
        **result,
    }


@router.post("/models/{model_id}/validate-bindings")
def validate_bindings(model_id: str, body: ValidateBindingsIn, db: Session = Depends(get_db)):
    if not db.get(Scene, body.scene_id):
        raise HTTPException(status_code=404, detail="Scene not found")
    model_schema = get_model_schema(model_id)
    if not model_schema:
        raise HTTPException(status_code=404, detail="Model not found")
    rows = (
        db.query(DataFile)
        .join(SceneImport, SceneImport.file_id == DataFile.id)
        .filter(SceneImport.scene_id == body.scene_id)
        .all()
    )
    asset_filenames = {data_file.id: data_file.path for data_file in rows}
    data_files = {data_file.id: data_file for data_file in rows}
    try:
        inputs = build_model_inputs_from_bindings(
            model_schema,
            body.binding_report,
            asset_filenames,
            body.parameters,
        )
        validation = check_model_inputs(
            model_id,
            inputs,
            project_files_dir(),
            files_util.read_file_metadata,
        )
        asset_fingerprints = build_asset_fingerprints(body.binding_report, data_files)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Model not found") from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    snapshot_id = validation_snapshot_id(model_id, body.scene_id, inputs, asset_fingerprints)
    can_proceed = validation.get("status") != "error"
    snapshot = db.get(ValidationSnapshot, snapshot_id)
    if not snapshot:
        snapshot = ValidationSnapshot(
            id=snapshot_id,
            scene_id=body.scene_id,
            model_id=model_id,
            status="awaiting_confirmation" if can_proceed else "validation_failed",
            can_proceed=can_proceed,
            inputs=inputs,
            binding_report=body.binding_report,
            validation=validation,
            asset_fingerprints=asset_fingerprints,
        )
        db.add(snapshot)
        db.commit()
        db.refresh(snapshot)
    return {
        "model_id": model_id,
        "scene_id": body.scene_id,
        "snapshot_id": snapshot.id,
        "snapshot_status": snapshot.status,
        "can_proceed": can_proceed,
        "inputs": inputs,
        "validation": validation,
        "asset_fingerprints": asset_fingerprints,
    }


def _invalidate_if_assets_changed(snapshot: ValidationSnapshot, db: Session) -> list[str]:
    asset_ids = list((snapshot.asset_fingerprints or {}).keys())
    rows = db.query(DataFile).filter(DataFile.id.in_(asset_ids)).all() if asset_ids else []
    changed = changed_asset_fingerprints(
        snapshot.asset_fingerprints or {},
        {data_file.id: data_file for data_file in rows},
    )
    if changed:
        snapshot.status = next_snapshot_status(snapshot.status, "invalidate", snapshot.can_proceed)
        db.commit()
    return changed


@router.get("/validation-snapshots/{snapshot_id}")
def get_validation_snapshot(snapshot_id: str, db: Session = Depends(get_db)):
    snapshot = db.get(ValidationSnapshot, snapshot_id)
    if not snapshot:
        raise HTTPException(status_code=404, detail="Validation snapshot not found")
    return _snapshot_dict(snapshot)


@router.post("/validation-snapshots/{snapshot_id}/confirm")
def confirm_validation_snapshot(
    snapshot_id: str,
    body: ConfirmSnapshotIn,
    db: Session = Depends(get_db),
):
    snapshot = db.query(ValidationSnapshot).filter(ValidationSnapshot.id == snapshot_id).with_for_update().first()
    if not snapshot:
        raise HTTPException(status_code=404, detail="Validation snapshot not found")
    if body.confirmed:
        changed = _invalidate_if_assets_changed(snapshot, db)
        if changed:
            raise HTTPException(
                status_code=409,
                detail=f"Validation snapshot inputs changed after validation: {', '.join(changed)}",
            )
    try:
        snapshot.status = next_snapshot_status(
            snapshot.status,
            "confirm" if body.confirmed else "reject",
            snapshot.can_proceed,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    now = datetime.utcnow()
    if body.confirmed:
        snapshot.confirmed_at = now
    else:
        snapshot.rejected_at = now
    db.commit()
    db.refresh(snapshot)
    return _snapshot_dict(snapshot)


@router.post("/validation-snapshots/{snapshot_id}/jobs", status_code=201)
def create_job_from_validation_snapshot(
    snapshot_id: str,
    body: SnapshotJobIn,
    db: Session = Depends(get_db),
):
    snapshot = db.query(ValidationSnapshot).filter(ValidationSnapshot.id == snapshot_id).with_for_update().first()
    if not snapshot:
        raise HTTPException(status_code=404, detail="Validation snapshot not found")
    changed = _invalidate_if_assets_changed(snapshot, db)
    if changed:
        raise HTTPException(
            status_code=409,
            detail=f"Validation snapshot inputs changed after validation: {', '.join(changed)}",
        )
    existing = db.query(Job).filter(Job.source_snapshot_id == snapshot_id).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"Validation snapshot already created job: {existing.id}")
    try:
        snapshot.status = next_snapshot_status(snapshot.status, "consume", snapshot.can_proceed)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    snapshot.consumed_at = datetime.utcnow()
    return create_scene_job_record(
        snapshot.scene_id,
        snapshot.model_id,
        snapshot.inputs,
        body.run_mode,
        db,
        source_snapshot_id=snapshot.id,
        asset_fingerprints=snapshot.asset_fingerprints,
    )
