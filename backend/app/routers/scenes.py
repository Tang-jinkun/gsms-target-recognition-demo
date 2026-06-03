"""Scenes CRUD — replaces scenesRepo (localStorage) on the frontend."""
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Scene
from app.storage import scene_dir
import shutil

router = APIRouter(prefix="/api/scenes", tags=["scenes"])


class SceneIn(BaseModel):
    name: str
    description: str = ""
    study_area: str = ""
    note: str = ""


class SceneOut(BaseModel):
    id: str
    name: str
    desc: str          # frontend field name
    region: str        # frontend field name for study_area
    note: str
    updated: str       # frontend field name, ISO date string

    model_config = {"from_attributes": True}

    @classmethod
    def from_orm_scene(cls, s: Scene) -> "SceneOut":
        return cls(
            id=s.id,
            name=s.name,
            desc=s.description,
            region=s.study_area,
            note=s.note,
            updated=s.updated_at.strftime("%Y-%m-%d") if s.updated_at else "",
        )


@router.get("", response_model=list[SceneOut])
def list_scenes(q: str = "", db: Session = Depends(get_db)):
    query = db.query(Scene).order_by(Scene.updated_at.desc())
    if q:
        like = f"%{q}%"
        query = query.filter((Scene.name.ilike(like)) | (Scene.description.ilike(like)))
    return [SceneOut.from_orm_scene(s) for s in query.all()]


@router.post("", response_model=SceneOut, status_code=201)
def create_scene(body: SceneIn, db: Session = Depends(get_db)):
    scene = Scene(
        name=body.name,
        description=body.description,
        study_area=body.study_area,
        note=body.note,
    )
    db.add(scene)
    db.commit()
    db.refresh(scene)
    # Ensure scene directory exists
    scene_dir(scene.id)
    return SceneOut.from_orm_scene(scene)


@router.get("/{scene_id}", response_model=SceneOut)
def get_scene(scene_id: str, db: Session = Depends(get_db)):
    scene = db.get(Scene, scene_id)
    if not scene:
        raise HTTPException(status_code=404, detail="Scene not found")
    return SceneOut.from_orm_scene(scene)


@router.put("/{scene_id}", response_model=SceneOut)
def update_scene(scene_id: str, body: SceneIn, db: Session = Depends(get_db)):
    scene = db.get(Scene, scene_id)
    if not scene:
        raise HTTPException(status_code=404, detail="Scene not found")
    scene.name = body.name
    scene.description = body.description
    scene.study_area = body.study_area
    scene.note = body.note
    scene.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(scene)
    return SceneOut.from_orm_scene(scene)


@router.delete("/{scene_id}", status_code=204)
def delete_scene(scene_id: str, db: Session = Depends(get_db)):
    scene = db.get(Scene, scene_id)
    if not scene:
        raise HTTPException(status_code=404, detail="Scene not found")
    db.delete(scene)
    db.commit()
    # Remove scene directory (jobs/outputs) but NOT Data Hub files
    d = scene_dir(scene_id)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
