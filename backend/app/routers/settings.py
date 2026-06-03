"""User profile and encrypted LLM provider settings."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import crypto
from app.db import get_db
from app.models import LlmProvider, User

router = APIRouter(prefix="/api/settings", tags=["settings"])


class UserIn(BaseModel):
    name: str = ""
    username: str | None = None
    email: str = ""
    org: str = ""
    organization: str | None = None
    field: str = ""
    research_field: str | None = None


class ProviderIn(BaseModel):
    name: str
    provider: str = "Custom"
    id: str | None = None
    model_id: str | None = None
    url: str | None = None
    base_url: str | None = None
    key: str | None = None
    api_key: str | None = None
    def_: bool | None = Field(default=None, alias="def")
    is_default: bool | None = None
    status: str | None = None

    model_config = {"populate_by_name": True}


def _get_user(db: Session) -> User:
    user = db.get(User, 1)
    if not user:
        user = User(id=1)
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


def _user_dict(user: User) -> dict:
    return {
        "name": user.username or "",
        "username": user.username or "",
        "email": user.email or "",
        "org": user.organization or "",
        "organization": user.organization or "",
        "field": user.research_field or "",
        "research_field": user.research_field or "",
    }


def _provider_dict(provider: LlmProvider) -> dict:
    key_mask = None
    if provider.api_key_enc:
        try:
            key_mask = crypto.mask(crypto.decrypt(provider.api_key_enc))
        except Exception:
            key_mask = "****"
    return {
        "provider_id": provider.id,
        "name": provider.name,
        "provider": provider.provider,
        "id": provider.model_id,
        "model_id": provider.model_id,
        "url": provider.base_url,
        "base_url": provider.base_url,
        "status": provider.status,
        "def": provider.is_default,
        "is_default": provider.is_default,
        "key_mask": key_mask,
        "has_api_key": bool(provider.api_key_enc),
    }


def _apply_default(db: Session, selected: LlmProvider) -> None:
    for row in db.query(LlmProvider).filter(LlmProvider.id != selected.id).all():
        row.is_default = False
    selected.is_default = True


def _apply_provider(provider: LlmProvider, body: ProviderIn) -> None:
    provider.name = body.name.strip()
    provider.provider = body.provider or "Custom"
    provider.model_id = (body.model_id if body.model_id is not None else body.id) or ""
    provider.base_url = (body.base_url if body.base_url is not None else body.url) or ""
    provider.status = body.status or provider.status or "untested"
    api_key = body.api_key if body.api_key is not None else body.key
    if api_key:
        provider.api_key_enc = crypto.encrypt(api_key)
    provider.updated_at = datetime.utcnow()


@router.get("/user")
def get_user(db: Session = Depends(get_db)):
    return _user_dict(_get_user(db))


@router.put("/user")
def update_user(body: UserIn, db: Session = Depends(get_db)):
    user = _get_user(db)
    user.username = body.username if body.username is not None else body.name
    user.email = body.email
    user.organization = body.organization if body.organization is not None else body.org
    user.research_field = body.research_field if body.research_field is not None else body.field
    db.commit()
    db.refresh(user)
    return _user_dict(user)


@router.get("/llm-providers")
def list_providers(db: Session = Depends(get_db)):
    rows = db.query(LlmProvider).order_by(LlmProvider.is_default.desc(), LlmProvider.created_at.desc()).all()
    return [_provider_dict(row) for row in rows]


@router.post("/llm-providers", status_code=201)
def create_provider(body: ProviderIn, db: Session = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="Provider name is required")
    row = LlmProvider(name=body.name.strip())
    _apply_provider(row, body)
    db.add(row)
    db.flush()
    make_default = body.is_default if body.is_default is not None else body.def_
    if make_default or db.query(LlmProvider).count() == 1:
        _apply_default(db, row)
    db.commit()
    db.refresh(row)
    return _provider_dict(row)


@router.put("/llm-providers/{provider_id}")
def update_provider(provider_id: str, body: ProviderIn, db: Session = Depends(get_db)):
    row = db.get(LlmProvider, provider_id)
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")
    _apply_provider(row, body)
    make_default = body.is_default if body.is_default is not None else body.def_
    if make_default:
        _apply_default(db, row)
    elif make_default is False:
        row.is_default = False
    db.commit()
    db.refresh(row)
    return _provider_dict(row)


@router.delete("/llm-providers/{provider_id}", status_code=204)
def delete_provider(provider_id: str, db: Session = Depends(get_db)):
    row = db.get(LlmProvider, provider_id)
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")
    was_default = row.is_default
    db.delete(row)
    db.commit()
    if was_default:
        replacement = db.query(LlmProvider).order_by(LlmProvider.created_at.desc()).first()
        if replacement:
            replacement.is_default = True
            db.commit()


@router.post("/llm-providers/{provider_id}/default")
def set_default_provider(provider_id: str, db: Session = Depends(get_db)):
    row = db.get(LlmProvider, provider_id)
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")
    _apply_default(db, row)
    db.commit()
    db.refresh(row)
    return _provider_dict(row)


@router.post("/llm-providers/{provider_id}/test")
def test_provider(provider_id: str, db: Session = Depends(get_db)):
    row = db.get(LlmProvider, provider_id)
    if not row:
        raise HTTPException(status_code=404, detail="Provider not found")
    ok = bool(row.model_id and (row.base_url or row.provider.lower() == "local") and row.api_key_enc)
    row.status = "connected" if ok else "failed"
    row.updated_at = datetime.utcnow()
    db.commit()
    return {"status": row.status, "ok": ok}
