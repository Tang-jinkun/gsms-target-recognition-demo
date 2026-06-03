"""Scene file imports — references to Data Hub files used inside a scene.

Drives the workbench 「文件」 tab. Files are NOT copied; a scene records which
DataFiles it imported (by reference).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Scene, DataFile, SceneImport
from app.routers.data import wb_file_dict

router = APIRouter(prefix="/api/scenes", tags=["scene-files"])


class ImportIn(BaseModel):
    fileIds: list[str]


def _require_scene(scene_id: str, db: Session) -> Scene:
    scene = db.get(Scene, scene_id)
    if not scene:
        raise HTTPException(status_code=404, detail="Scene not found")
    return scene


@router.get("/{scene_id}/files")
def list_scene_files(scene_id: str, db: Session = Depends(get_db)):
    _require_scene(scene_id, db)
    rows = (
        db.query(DataFile)
        .join(SceneImport, SceneImport.file_id == DataFile.id)
        .filter(SceneImport.scene_id == scene_id)
        .order_by(SceneImport.imported_at.desc())
        .all()
    )
    return [wb_file_dict(df) for df in rows]


@router.post("/{scene_id}/imports", status_code=201)
def import_files(scene_id: str, body: ImportIn, db: Session = Depends(get_db)):
    _require_scene(scene_id, db)
    added = 0
    for fid in body.fileIds:
        if not db.get(DataFile, fid):
            continue
        exists = db.get(SceneImport, {"scene_id": scene_id, "file_id": fid})
        if exists:
            continue
        db.add(SceneImport(scene_id=scene_id, file_id=fid))
        added += 1
    db.commit()
    return {"imported": added}


@router.delete("/{scene_id}/imports/{file_id}", status_code=204)
def remove_import(scene_id: str, file_id: str, db: Session = Depends(get_db)):
    link = db.get(SceneImport, {"scene_id": scene_id, "file_id": file_id})
    if link:
        db.delete(link)
        db.commit()
