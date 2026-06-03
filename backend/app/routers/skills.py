"""Local Skills metadata and file browser APIs."""
from __future__ import annotations

import html
import shutil
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Skill
from app.storage import skill_dir, skills_root

router = APIRouter(prefix="/api/skills", tags=["skills"])

TEXT_SUFFIXES = {".md", ".txt", ".py", ".js", ".ts", ".tsx", ".json", ".yml", ".yaml", ".toml", ".csv"}
CODE_SUFFIXES = {".py", ".js", ".ts", ".tsx", ".sql", ".sh", ".ps1"}


class SkillIn(BaseModel):
    name: str
    desc: str = ""
    description: str | None = None


def _slug(value: str) -> str:
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-")
    return "-".join(part for part in slug.split("-") if part)[:48] or uuid.uuid4().hex[:12]


def _skill_dict(skill: Skill) -> dict:
    return {
        "id": skill.id,
        "name": skill.name,
        "desc": skill.description or "",
        "updated": skill.updated_at.strftime("%Y-%m-%d") if skill.updated_at else "",
    }


def _require_skill(skill_id: str, db: Session) -> Skill:
    skill = db.get(Skill, skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")
    return skill


def _root_for(skill: Skill) -> Path:
    root = skills_root().resolve()
    path = (root / Path(skill.dir_path).name).resolve()
    if root not in path.parents and path != root:
        raise HTTPException(status_code=400, detail="Invalid skill path")
    return path


def _safe_child(root: Path, rel_path: str) -> Path:
    path = (root / rel_path).resolve()
    if root not in path.parents and path != root:
        raise HTTPException(status_code=400, detail="Invalid file path")
    return path


def _fmt_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / 1024 / 1024:.1f} MB"


def _kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".md":
        return "md"
    if suffix in CODE_SUFFIXES:
        return "code"
    if suffix == ".json":
        return "json"
    return "bin" if suffix not in TEXT_SUFFIXES else "code"


def _tree(path: Path) -> list[dict]:
    if not path.exists():
        return []
    nodes: list[dict] = []
    for child in sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if child.name.startswith("."):
            continue
        if child.is_dir():
            nodes.append({"name": child.name, "type": "dir", "children": _tree(child)})
            continue
        stat = child.stat()
        nodes.append({
            "name": child.name,
            "type": "file",
            "kind": _kind(child),
            "size": _fmt_size(stat.st_size),
            "modified": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
        })
    return nodes


def _md_to_html(text: str) -> str:
    lines = text.splitlines()
    parts: list[str] = []
    in_list = False
    for line in lines:
        stripped = line.strip()
        if not stripped:
            if in_list:
                parts.append("</ul>")
                in_list = False
            continue
        if stripped.startswith("#"):
            if in_list:
                parts.append("</ul>")
                in_list = False
            level = min(len(stripped) - len(stripped.lstrip("#")), 6)
            value = stripped[level:].strip()
            parts.append(f"<h{level}>{html.escape(value)}</h{level}>")
        elif stripped.startswith(("- ", "* ")):
            if not in_list:
                parts.append("<ul>")
                in_list = True
            parts.append(f"<li>{html.escape(stripped[2:])}</li>")
        else:
            if in_list:
                parts.append("</ul>")
                in_list = False
            parts.append(f"<p>{html.escape(stripped)}</p>")
    if in_list:
        parts.append("</ul>")
    return "\n".join(parts)


def _write_default_skill(root: Path, name: str, description: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        f"# {name}\n\n{description or 'Local GSMS skill.'}\n\n## Usage\n\n- Use from the GSMS workbench when this workflow is relevant.\n",
        encoding="utf-8",
    )
    scripts = root / "scripts"
    scripts.mkdir(exist_ok=True)
    (scripts / "run.py").write_text("def run(args):\n    return args\n", encoding="utf-8")


@router.get("")
def list_skills(q: str = "", db: Session = Depends(get_db)):
    query = db.query(Skill).order_by(Skill.updated_at.desc())
    if q:
        like = f"%{q}%"
        query = query.filter((Skill.name.ilike(like)) | (Skill.description.ilike(like)))
    return [_skill_dict(skill) for skill in query.all()]


@router.post("", status_code=201)
def create_skill(body: SkillIn, db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Skill name is required")
    exists = db.query(Skill).filter(Skill.name.ilike(name)).first()
    if exists:
        raise HTTPException(status_code=409, detail="Skill name already exists")
    skill_id = _slug(name)
    if db.get(Skill, skill_id):
        skill_id = f"{skill_id}-{uuid.uuid4().hex[:6]}"
    description = body.description if body.description is not None else body.desc
    skill = Skill(id=skill_id, name=name, description=description or "", dir_path=skill_id)
    db.add(skill)
    db.commit()
    _write_default_skill(skill_dir(skill_id), skill.name, skill.description)
    db.refresh(skill)
    return _skill_dict(skill)


@router.get("/{skill_id}")
def get_skill(skill_id: str, db: Session = Depends(get_db)):
    return _skill_dict(_require_skill(skill_id, db))


@router.put("/{skill_id}")
def update_skill(skill_id: str, body: SkillIn, db: Session = Depends(get_db)):
    skill = _require_skill(skill_id, db)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Skill name is required")
    exists = db.query(Skill).filter(Skill.name.ilike(name), Skill.id != skill_id).first()
    if exists:
        raise HTTPException(status_code=409, detail="Skill name already exists")
    skill.name = name
    skill.description = body.description if body.description is not None else body.desc
    skill.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(skill)
    return _skill_dict(skill)


@router.delete("/{skill_id}", status_code=204)
def delete_skill(skill_id: str, db: Session = Depends(get_db)):
    skill = _require_skill(skill_id, db)
    root = _root_for(skill)
    db.delete(skill)
    db.commit()
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)


@router.get("/{skill_id}/tree")
def skill_tree(skill_id: str, db: Session = Depends(get_db)):
    skill = _require_skill(skill_id, db)
    return _tree(_root_for(skill))


@router.get("/{skill_id}/content")
def skill_content(skill_id: str, path: str = "SKILL.md", db: Session = Depends(get_db)):
    skill = _require_skill(skill_id, db)
    root = _root_for(skill)
    file_path = _safe_child(root, path)
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Skill file not found")
    kind = _kind(file_path)
    size = _fmt_size(file_path.stat().st_size)
    if kind == "bin":
        return {"kind": "bin", "size": size}
    try:
        text = file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return {"kind": "bin", "size": size}
    if kind == "md":
        return {"kind": "md", "html": _md_to_html(text)}
    return {"kind": kind, "code": html.escape(text)}
