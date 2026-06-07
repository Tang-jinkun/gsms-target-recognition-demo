"""Server-side OpenAI-compatible proxy used by the local InVEST Agent CLI."""
from __future__ import annotations

import json
import hmac
import os
import uuid
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Depends, HTTPException, Query, Request as FastApiRequest
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import crypto
from app.agent_sessions import (
    consume_confirmation_status,
    next_confirmation_status,
    next_session_status,
)
from app.db import get_db
from app.llm_proxy import chat_completions_url
from app.models import (
    AgentConfirmation,
    AgentEvent,
    AgentMessage,
    AgentSession,
    LlmProvider,
    Scene,
)

router = APIRouter(prefix="/api/agent", tags=["agent"])
ACTION_EVENT_TYPES = {
    "run.started",
    "model.responded",
    "tool.started",
    "tool.completed",
    "tool.deferred",
    "tool.failed",
    "state.changed",
    "artifact.created",
    "diagnostic.created",
    "loop.detected",
    "run.paused",
    "run.completed",
    "run.failed",
}


class SessionCreateIn(BaseModel):
    scene_id: str
    title: str = ""


class MessageCreateIn(BaseModel):
    content: str = Field(min_length=1, max_length=100_000)


class ConfirmationCreateIn(BaseModel):
    kind: str = Field(min_length=1, max_length=50)
    prompt: str = Field(min_length=1, max_length=10_000)
    payload: dict = Field(default_factory=dict)


class ConfirmationResolveIn(BaseModel):
    approved: bool


class SessionCheckpointIn(BaseModel):
    action: str
    domain_state: dict | None = None
    artifacts: list | None = None
    assistant_message: str | None = Field(default=None, max_length=100_000)
    error: str | None = Field(default=None, max_length=20_000)


class AgentEventCreateIn(BaseModel):
    event_type: str = Field(min_length=1, max_length=50)
    data: dict = Field(default_factory=dict)


def _default_model_config(db: Session) -> dict:
    provider = (
        db.query(LlmProvider)
        .order_by(LlmProvider.is_default.desc(), LlmProvider.created_at.desc())
        .first()
    )
    if not provider:
        return {}
    return {
        "provider_id": provider.id,
        "provider": provider.provider,
        "model_id": provider.model_id,
        "base_url": provider.base_url,
    }


def _session_dict(session: AgentSession) -> dict:
    return {
        "id": session.id,
        "scene_id": session.scene_id,
        "title": session.title,
        "status": session.status,
        "domain_state": session.domain_state,
        "artifacts": session.artifacts,
        "model_config": session.model_config,
        "last_error": session.last_error,
        "created_at": session.created_at.isoformat() if session.created_at else None,
        "updated_at": session.updated_at.isoformat() if session.updated_at else None,
        "pending_confirmation_id": next(
            (
                confirmation.id
                for confirmation in reversed(session.confirmations)
                if confirmation.status == "pending"
            ),
            None,
        ),
    }


def _message_dict(message: AgentMessage) -> dict:
    return {
        "id": message.id,
        "session_id": message.session_id,
        "role": message.role,
        "content": message.content,
        "metadata": message.metadata_json,
        "created_at": message.created_at.isoformat() if message.created_at else None,
    }


def _event_dict(event: AgentEvent) -> dict:
    return {
        "id": event.id,
        "session_id": event.session_id,
        "type": event.event_type,
        "data": event.data,
        "created_at": event.created_at.isoformat() if event.created_at else None,
    }


def _confirmation_dict(confirmation: AgentConfirmation) -> dict:
    return {
        "id": confirmation.id,
        "session_id": confirmation.session_id,
        "kind": confirmation.kind,
        "status": confirmation.status,
        "prompt": confirmation.prompt,
        "payload": confirmation.payload,
        "created_at": confirmation.created_at.isoformat() if confirmation.created_at else None,
        "resolved_at": confirmation.resolved_at.isoformat() if confirmation.resolved_at else None,
    }


def _require_session(session_id: str, db: Session) -> AgentSession:
    session = db.get(AgentSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return session


def _add_event(db: Session, session_id: str, event_type: str, data: dict) -> AgentEvent:
    event = AgentEvent(session_id=session_id, event_type=event_type, data=data)
    db.add(event)
    db.flush()
    return event


@router.post("/sessions", status_code=201)
def create_agent_session(body: SessionCreateIn, db: Session = Depends(get_db)):
    scene = db.get(Scene, body.scene_id)
    if not scene:
        raise HTTPException(status_code=404, detail="Scene not found")
    session = AgentSession(
        id=uuid.uuid4().hex,
        scene_id=body.scene_id,
        title=body.title.strip() or f"Agent session for {scene.name}",
        status="idle",
        domain_state={"sceneId": body.scene_id, "phase": "conversation-ready"},
        artifacts=[],
        model_config=_default_model_config(db),
    )
    db.add(session)
    db.flush()
    _add_event(db, session.id, "session.created", {"scene_id": body.scene_id})
    db.commit()
    db.refresh(session)
    return _session_dict(session)


@router.get("/sessions")
def list_agent_sessions(
    scene_id: str | None = None,
    status: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    query = db.query(AgentSession)
    if scene_id:
        query = query.filter(AgentSession.scene_id == scene_id)
    if status:
        query = query.filter(AgentSession.status == status)
    rows = query.order_by(AgentSession.updated_at.desc()).limit(limit).all()
    return [_session_dict(session) for session in rows]


@router.get("/sessions/{session_id}")
def get_agent_session(session_id: str, db: Session = Depends(get_db)):
    return _session_dict(_require_session(session_id, db))


@router.get("/sessions/{session_id}/messages")
def list_agent_messages(session_id: str, db: Session = Depends(get_db)):
    _require_session(session_id, db)
    rows = (
        db.query(AgentMessage)
        .filter(AgentMessage.session_id == session_id)
        .order_by(AgentMessage.created_at.asc())
        .all()
    )
    return [_message_dict(message) for message in rows]


@router.post("/sessions/{session_id}/messages", status_code=202)
def enqueue_agent_message(
    session_id: str,
    body: MessageCreateIn,
    db: Session = Depends(get_db),
):
    session = (
        db.query(AgentSession)
        .filter(AgentSession.id == session_id)
        .with_for_update()
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Agent session not found")
    try:
        session.status = next_session_status(session.status, "enqueue_message")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Agent message cannot be blank.")
    message = AgentMessage(
        id=uuid.uuid4().hex,
        session_id=session.id,
        role="user",
        content=content,
        metadata_json={},
    )
    db.add(message)
    db.flush()
    event = _add_event(
        db,
        session.id,
        "message.queued",
        {"message_id": message.id, "role": message.role},
    )
    session.last_error = None
    db.commit()
    db.refresh(message)
    return {"session": _session_dict(session), "message": _message_dict(message), "event": _event_dict(event)}


@router.get("/sessions/{session_id}/events")
def list_agent_events(
    session_id: str,
    after_id: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    _require_session(session_id, db)
    rows = (
        db.query(AgentEvent)
        .filter(AgentEvent.session_id == session_id, AgentEvent.id > after_id)
        .order_by(AgentEvent.id.asc())
        .limit(limit)
        .all()
    )
    return [_event_dict(event) for event in rows]


@router.post("/sessions/{session_id}/events", status_code=201)
def create_agent_event(
    session_id: str,
    body: AgentEventCreateIn,
    db: Session = Depends(get_db),
):
    session = _require_session(session_id, db)
    if session.status not in ("running", "awaiting_confirmation"):
        raise HTTPException(status_code=409, detail="Agent session is not active.")
    if body.event_type not in ACTION_EVENT_TYPES:
        raise HTTPException(status_code=400, detail="Unsupported Agent action event type.")
    event = _add_event(db, session.id, body.event_type, body.data)
    db.commit()
    db.refresh(event)
    return _event_dict(event)


@router.post("/sessions/{session_id}/confirmations", status_code=201)
def request_agent_confirmation(
    session_id: str,
    body: ConfirmationCreateIn,
    db: Session = Depends(get_db),
):
    session = (
        db.query(AgentSession)
        .filter(AgentSession.id == session_id)
        .with_for_update()
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Agent session not found")
    if any(item.status == "pending" for item in session.confirmations):
        raise HTTPException(status_code=409, detail="Agent session already has a pending confirmation.")
    try:
        session.status = next_session_status(session.status, "request_confirmation")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    confirmation = AgentConfirmation(
        id=uuid.uuid4().hex,
        session_id=session.id,
        kind=body.kind,
        status="pending",
        prompt=body.prompt,
        payload=body.payload,
    )
    db.add(confirmation)
    db.flush()
    _add_event(
        db,
        session.id,
        "confirmation.requested",
        {"confirmation_id": confirmation.id, "kind": confirmation.kind},
    )
    db.commit()
    db.refresh(confirmation)
    return _confirmation_dict(confirmation)


@router.post("/sessions/{session_id}/confirmations/{confirmation_id}")
def resolve_agent_confirmation(
    session_id: str,
    confirmation_id: str,
    body: ConfirmationResolveIn,
    db: Session = Depends(get_db),
):
    session = (
        db.query(AgentSession)
        .filter(AgentSession.id == session_id)
        .with_for_update()
        .first()
    )
    confirmation = (
        db.query(AgentConfirmation)
        .filter(
            AgentConfirmation.id == confirmation_id,
            AgentConfirmation.session_id == session_id,
        )
        .with_for_update()
        .first()
    )
    if not session or not confirmation:
        raise HTTPException(status_code=404, detail="Agent confirmation not found")
    try:
        confirmation.status = next_confirmation_status(confirmation.status, body.approved)
        session.status = next_session_status(
            session.status,
            "approve_confirmation" if body.approved else "reject_confirmation",
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    confirmation.resolved_at = datetime.utcnow()
    _add_event(
        db,
        session.id,
        "confirmation.resolved",
        {
            "confirmation_id": confirmation.id,
            "status": confirmation.status,
        },
    )
    db.commit()
    db.refresh(confirmation)
    return {"session": _session_dict(session), "confirmation": _confirmation_dict(confirmation)}


@router.get("/sessions/{session_id}/confirmations")
def list_agent_confirmations(session_id: str, db: Session = Depends(get_db)):
    _require_session(session_id, db)
    rows = (
        db.query(AgentConfirmation)
        .filter(AgentConfirmation.session_id == session_id)
        .order_by(AgentConfirmation.created_at.asc())
        .all()
    )
    return [_confirmation_dict(confirmation) for confirmation in rows]


@router.post("/sessions/{session_id}/confirmations/{confirmation_id}/consume")
def consume_agent_confirmation(
    session_id: str,
    confirmation_id: str,
    db: Session = Depends(get_db),
):
    confirmation = (
        db.query(AgentConfirmation)
        .filter(
            AgentConfirmation.id == confirmation_id,
            AgentConfirmation.session_id == session_id,
        )
        .with_for_update()
        .first()
    )
    if not confirmation:
        raise HTTPException(status_code=404, detail="Agent confirmation not found")
    try:
        confirmation.status = consume_confirmation_status(confirmation.status)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    _add_event(
        db,
        session_id,
        "confirmation.consumed",
        {"confirmation_id": confirmation.id},
    )
    db.commit()
    db.refresh(confirmation)
    return _confirmation_dict(confirmation)


@router.post("/sessions/{session_id}/checkpoint")
def checkpoint_agent_session(
    session_id: str,
    body: SessionCheckpointIn,
    db: Session = Depends(get_db),
):
    session = (
        db.query(AgentSession)
        .filter(AgentSession.id == session_id)
        .with_for_update()
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Agent session not found")
    try:
        session.status = next_session_status(session.status, body.action)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if body.domain_state is not None:
        session.domain_state = body.domain_state
    if body.artifacts is not None:
        session.artifacts = body.artifacts
    if body.error is not None:
        session.last_error = body.error
    if body.assistant_message:
        message = AgentMessage(
            id=uuid.uuid4().hex,
            session_id=session.id,
            role="assistant",
            content=body.assistant_message,
            metadata_json={},
        )
        db.add(message)
        db.flush()
        _add_event(
            db,
            session.id,
            "message.created",
            {"message_id": message.id, "role": message.role},
        )
    _add_event(
        db,
        session.id,
        "session.checkpoint",
        {"action": body.action, "status": session.status},
    )
    db.commit()
    db.refresh(session)
    return _session_dict(session)


@router.post("/chat/completions")
def proxy_chat_completions(
    payload: dict,
    request: FastApiRequest,
    db: Session = Depends(get_db),
):
    expected_token = os.environ.get("GSMS_AGENT_PROXY_TOKEN", "")
    if not expected_token:
        raise HTTPException(status_code=503, detail="GSMS Agent model proxy is disabled.")
    supplied = request.headers.get("authorization", "")
    expected = f"Bearer {expected_token}"
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Invalid GSMS Agent proxy token.")
    provider = (
        db.query(LlmProvider)
        .order_by(LlmProvider.is_default.desc(), LlmProvider.created_at.desc())
        .first()
    )
    if not provider:
        raise HTTPException(status_code=503, detail="No GSMS LLM Provider is configured.")
    if not provider.model_id:
        raise HTTPException(status_code=503, detail="The default GSMS LLM Provider has no model ID.")
    try:
        target = chat_completions_url(provider.base_url or "")
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    forwarded = dict(payload)
    forwarded["model"] = provider.model_id
    headers = {"content-type": "application/json"}
    if provider.api_key_enc:
        try:
            headers["authorization"] = f"Bearer {crypto.decrypt(provider.api_key_enc)}"
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Could not decrypt the default Provider API key.") from exc

    request = Request(
        target,
        data=json.dumps(forwarded).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=120) as response:
            body = json.loads(response.read().decode("utf-8"))
            return JSONResponse(content=body, status_code=response.status)
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise HTTPException(status_code=502, detail=f"Provider HTTP {exc.code}: {detail[:2000]}") from exc
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail=f"Provider request failed: {exc}") from exc
