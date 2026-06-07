"""Agent-facing read-only APIs for data matching facts."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
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
