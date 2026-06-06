"""Data Hub — global project file store. Replaces dataHubRepo (static seed).

Files live on disk under project_files_dir(); metadata + vector geometry live in
Postgres/PostGIS. Vector uploads are ingested into the features table for
spatial queries.
"""
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import DataFile, DataFolder
from app.storage import project_files_dir, project_file_previews_dir
from app import files_util

router = APIRouter(prefix="/api/data", tags=["data-hub"])

UI_TYPE = {"raster": "raster", "geojson": "vector", "table": "table", "document": "text", "unknown": "other"}
UNCATEGORIZED_FOLDER_ID = "uncategorized"


class FolderIn(BaseModel):
    name: str


class MoveFilesIn(BaseModel):
    fileIds: list[str]
    folderId: str | None = None


class DeleteFilesIn(BaseModel):
    fileIds: list[str]


def ensure_uncategorized_folder(db: Session) -> DataFolder:
    folder = db.get(DataFolder, UNCATEGORIZED_FOLDER_ID)
    if not folder:
        folder = DataFolder(id=UNCATEGORIZED_FOLDER_ID, name="未分类")
        db.add(folder)
        db.flush()
    return folder


def _resolve(df: DataFile) -> Path:
    p = project_files_dir() / Path(df.path).name
    if not p.exists():
        raise HTTPException(status_code=404, detail="File missing on disk")
    return p


def _stored_paths(df: DataFile) -> tuple[Path, Path]:
    return (
        project_files_dir() / Path(df.path).name,
        project_file_previews_dir() / f"{df.id}.png",
    )


def _unlink_stored_paths(paths: list[Path]) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            # The database is authoritative. A later storage cleanup can remove
            # files that are temporarily locked or unavailable.
            pass


def _data_hub_dict(df: DataFile) -> dict:
    """Shape consumed by the Data Hub page (dataHubRepo)."""
    extra = df.extra_meta or {}
    spatial = None
    if df.file_type in {"raster", "geojson"}:
        bounds = df.bounds_wgs84 or df.bounds
        extent = f"{bounds[0]:.4g},{bounds[1]:.4g} — {bounds[2]:.4g},{bounds[3]:.4g}" if bounds else "—"
        spatial = {
            "crs": df.crs or "—",
            "geom": extra.get("geom", "—") if df.file_type == "geojson" else "—",
            "feat": extra.get("feature_count", "—"),
            "extent": extent,
            "res": "—",
            "bands": extra.get("band_count", "—"),
        }
    return {
        "id": df.id,
        "folder_id": df.folder_id,
        "folder_name": df.folder.name if df.folder else "未分类",
        "name": df.name,
        "type": UI_TYPE.get(df.file_type, "other"),
        "size": df.size,
        "fmt": df.file_format,
        "created": df.created_at.strftime("%Y-%m-%d %H:%M") if df.created_at else "—",
        "modified": df.updated_at.strftime("%Y-%m-%d %H:%M") if df.updated_at else "—",
        "enc": extra.get("enc", "—"),
        "note": extra.get("note", ""),
        "spatial": spatial,
    }


def wb_file_dict(df: DataFile) -> dict:
    """Shape consumed by the workbench file tab / map (workbenchRepo.WbFile)."""
    base = f"/api/data/files/{df.id}"
    return {
        "id": df.id,
        "folder_id": df.folder_id,
        "folder_name": df.folder.name if df.folder else "未分类",
        "name": df.name,
        "type": df.file_type,  # backend category; frontend maps geojson→vector
        "size": df.size,
        "preview_url": f"{base}/preview.png" if df.file_type == "raster" else None,
        "geojson_url": f"{base}/geojson" if df.file_type == "geojson" else None,
        "bounds": df.bounds_wgs84 or df.bounds,
    }


@router.get("/folders")
def list_folders(db: Session = Depends(get_db)):
    ensure_uncategorized_folder(db)
    rows = (
        db.query(DataFolder, func.count(DataFile.id))
        .outerjoin(DataFile, DataFile.folder_id == DataFolder.id)
        .group_by(DataFolder.id)
        .order_by(DataFolder.created_at.asc())
        .all()
    )
    return [
        {
            "id": folder.id,
            "name": folder.name,
            "count": count,
            "created_at": folder.created_at.isoformat() if folder.created_at else None,
        }
        for folder, count in rows
    ]


@router.post("/folders", status_code=201)
def create_folder(body: FolderIn, db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Folder name is required")
    exists = db.query(DataFolder).filter(DataFolder.name == name).first()
    if exists:
        raise HTTPException(status_code=409, detail="Folder already exists")
    folder = DataFolder(id=uuid.uuid4().hex, name=name)
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return {"id": folder.id, "name": folder.name, "count": 0}


@router.put("/folders/{folder_id}")
def rename_folder(folder_id: str, body: FolderIn, db: Session = Depends(get_db)):
    folder = db.get(DataFolder, folder_id)
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Folder name is required")
    duplicate = db.query(DataFolder).filter(DataFolder.name == name, DataFolder.id != folder_id).first()
    if duplicate:
        raise HTTPException(status_code=409, detail="Folder already exists")
    folder.name = name
    db.commit()
    db.refresh(folder)
    return {"id": folder.id, "name": folder.name}


@router.delete("/folders/{folder_id}", status_code=204)
def delete_folder(folder_id: str, db: Session = Depends(get_db)):
    if folder_id == UNCATEGORIZED_FOLDER_ID:
        raise HTTPException(status_code=400, detail="Cannot delete uncategorized folder")
    folder = db.get(DataFolder, folder_id)
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    files = db.query(DataFile).filter(DataFile.folder_id == folder_id).all()
    stored_paths = [path for df in files for path in _stored_paths(df)]
    for df in files:
        db.delete(df)
    db.delete(folder)
    db.commit()
    _unlink_stored_paths(stored_paths)


@router.post("/files/move")
def move_files(body: MoveFilesIn, db: Session = Depends(get_db)):
    folder_id = body.folderId or UNCATEGORIZED_FOLDER_ID
    folder = db.get(DataFolder, folder_id)
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    moved = 0
    for file_id in body.fileIds:
        df = db.get(DataFile, file_id)
        if not df:
            continue
        df.folder_id = folder_id
        moved += 1
    db.commit()
    return {"moved": moved}


@router.post("/files/delete")
def delete_files(body: DeleteFilesIn, db: Session = Depends(get_db)):
    file_ids = list(dict.fromkeys(body.fileIds))
    if not file_ids:
        return {"deleted": 0}
    files = db.query(DataFile).filter(DataFile.id.in_(file_ids)).all()
    stored_paths = [path for df in files for path in _stored_paths(df)]
    for df in files:
        db.delete(df)
    db.commit()
    _unlink_stored_paths(stored_paths)
    return {"deleted": len(files)}


@router.get("/files")
def list_files(q: str = "", folder_id: str | None = None, type: str | None = None, sort: str = "created_desc", db: Session = Depends(get_db)):
    ensure_uncategorized_folder(db)
    query = db.query(DataFile)
    if q:
        query = query.filter(DataFile.name.ilike(f"%{q}%"))
    if folder_id:
        query = query.filter(DataFile.folder_id == folder_id)
    if type:
        backend_type = "geojson" if type == "vector" else "document" if type == "text" else type
        if type == "other":
            query = query.filter(DataFile.file_type.in_(["unknown", "other"]))
        else:
            query = query.filter(DataFile.file_type == backend_type)
    if sort == "name":
        query = query.order_by(DataFile.name.asc())
    elif sort == "size":
        query = query.order_by(DataFile.size.desc())
    elif sort == "time":
        query = query.order_by(DataFile.created_at.desc())
    else:
        query = query.order_by(DataFile.created_at.desc())
    return [_data_hub_dict(df) for df in query.all()]


@router.post("/files/upload")
async def upload_file(file: UploadFile = File(...), folder_id: str | None = None, db: Session = Depends(get_db)):
    folder = db.get(DataFolder, folder_id) if folder_id else ensure_uncategorized_folder(db)
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    files_dir = project_files_dir()
    safe = Path(file.filename or "upload.bin").name
    dest = files_dir / safe
    if dest.exists():
        stem = Path(safe)
        dest = files_dir / f"{stem.stem}.{uuid.uuid4().hex}{stem.suffix}"
    with dest.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)

    meta = files_util.read_file_metadata(dest)
    core = {"name", "file_type", "file_format", "size", "crs", "bounds", "bounds_wgs84"}
    extra = {k: v for k, v in meta.items() if k not in core}

    df = DataFile(
        id=uuid.uuid4().hex,
        name=dest.name,
        file_type=meta.get("file_type", "unknown"),
        file_format=meta.get("file_format", "unknown"),
        size=meta.get("size", 0),
        path=dest.name,
        folder_id=folder.id,
        crs=meta.get("crs"),
        bounds=meta.get("bounds"),
        bounds_wgs84=meta.get("bounds_wgs84"),
        extra_meta=extra or None,
    )
    db.add(df)
    db.commit()
    db.refresh(df)

    # Ingest vector geometry into PostGIS for spatial queries
    if df.file_type == "geojson":
        try:
            files_util.ingest_vector_features(dest, df.id, db)
        except Exception:
            pass  # geometry ingest is best-effort; file is still usable

    return _data_hub_dict(df)


@router.delete("/files/{file_id}", status_code=204)
def delete_file(file_id: str, db: Session = Depends(get_db)):
    df = db.get(DataFile, file_id)
    if not df:
        raise HTTPException(status_code=404, detail="File not found")
    stored_paths = list(_stored_paths(df))
    db.delete(df)  # cascades features + scene_imports
    db.commit()
    _unlink_stored_paths(stored_paths)


@router.get("/files/{file_id}/metadata")
def file_metadata(file_id: str, db: Session = Depends(get_db)):
    df = db.get(DataFile, file_id)
    if not df:
        raise HTTPException(status_code=404, detail="File not found")
    return files_util.read_file_metadata(_resolve(df))


@router.get("/files/{file_id}/geojson")
def file_geojson(file_id: str, db: Session = Depends(get_db)):
    df = db.get(DataFile, file_id)
    if not df:
        raise HTTPException(status_code=404, detail="File not found")
    return files_util.read_geojson_file(_resolve(df))


@router.api_route("/files/{file_id}/preview.png", methods=["GET", "HEAD"])
def file_preview(file_id: str, request: Request, max_size: int = 1024, db: Session = Depends(get_db)):
    df = db.get(DataFile, file_id)
    if not df:
        raise HTTPException(status_code=404, detail="File not found")
    src = _resolve(df)
    if src.suffix.lower() not in {".tif", ".tiff"}:
        raise HTTPException(status_code=400, detail="File is not a GeoTIFF")
    preview = project_file_previews_dir() / f"{df.id}.png"
    if request.method == "HEAD":
        headers = {"Content-Type": "image/png"}
        if preview.exists():
            headers["Content-Length"] = str(preview.stat().st_size)
        return Response(status_code=200, headers=headers)
    if preview.exists() and preview.stat().st_mtime >= src.stat().st_mtime:
        return FileResponse(str(preview), media_type="image/png")
    files_util.generate_raster_preview(src, preview, max_size=max_size)
    return FileResponse(str(preview), media_type="image/png")
