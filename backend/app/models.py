"""SQLAlchemy ORM models (PostgreSQL + PostGIS)."""
import uuid
from datetime import datetime

from geoalchemy2 import Geometry
from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Integer, String, Text, func
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class Scene(Base):
    __tablename__ = "scenes"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    study_area: Mapped[str] = mapped_column(String(200), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    imports: Mapped[list["SceneImport"]] = relationship("SceneImport", back_populates="scene", cascade="all, delete-orphan")
    jobs: Mapped[list["Job"]] = relationship("Job", back_populates="scene", cascade="all, delete-orphan")
    validation_snapshots: Mapped[list["ValidationSnapshot"]] = relationship(
        "ValidationSnapshot",
        back_populates="scene",
        cascade="all, delete-orphan",
    )
    agent_sessions: Mapped[list["AgentSession"]] = relationship(
        "AgentSession",
        back_populates="scene",
        cascade="all, delete-orphan",
    )


class DataFolder(Base):
    """Single-level Data Hub folder."""
    __tablename__ = "data_folders"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    files: Mapped[list["DataFile"]] = relationship("DataFile", back_populates="folder")


class DataFile(Base):
    """Global Data Hub file record."""
    __tablename__ = "data_files"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    folder_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("data_folders.id", ondelete="SET NULL"), index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_type: Mapped[str] = mapped_column(String(50), default="unknown")  # raster/geojson/table/document/unknown
    file_format: Mapped[str] = mapped_column(String(50), default="unknown")
    size: Mapped[int] = mapped_column(Integer, default=0)
    path: Mapped[str] = mapped_column(Text, nullable=False)  # relative to project_files_dir()
    crs: Mapped[str | None] = mapped_column(String(100))
    bounds: Mapped[list | None] = mapped_column(JSONB)         # [w, s, e, n] native CRS
    bounds_wgs84: Mapped[list | None] = mapped_column(JSONB)   # [w, s, e, n] WGS84
    extra_meta: Mapped[dict | None] = mapped_column(JSONB)     # columns/row_count/band_count/…
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    folder: Mapped["DataFolder | None"] = relationship("DataFolder", back_populates="files")
    imports: Mapped[list["SceneImport"]] = relationship(
        "SceneImport",
        back_populates="data_file",
        passive_deletes="all",
    )
    features: Mapped[list["Feature"]] = relationship(
        "Feature",
        back_populates="data_file",
        passive_deletes="all",
    )


class SceneImport(Base):
    """Many-to-many: which DataFiles a Scene has imported (by reference)."""
    __tablename__ = "scene_imports"

    scene_id: Mapped[str] = mapped_column(String(32), ForeignKey("scenes.id", ondelete="CASCADE"), primary_key=True)
    file_id: Mapped[str] = mapped_column(String(32), ForeignKey("data_files.id", ondelete="CASCADE"), primary_key=True)
    imported_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    scene: Mapped["Scene"] = relationship("Scene", back_populates="imports")
    data_file: Mapped["DataFile"] = relationship("DataFile", back_populates="imports")


class Feature(Base):
    """Vector features from a DataFile — enables spatial queries via PostGIS."""
    __tablename__ = "features"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    file_id: Mapped[str] = mapped_column(String(32), ForeignKey("data_files.id", ondelete="CASCADE"), nullable=False, index=True)
    geom = mapped_column(Geometry("GEOMETRY", srid=4326), nullable=False)
    properties: Mapped[dict | None] = mapped_column(JSONB)

    data_file: Mapped["DataFile"] = relationship("DataFile", back_populates="features")


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    scene_id: Mapped[str] = mapped_column(String(32), ForeignKey("scenes.id", ondelete="CASCADE"), nullable=False, index=True)
    model_id: Mapped[str] = mapped_column(String(100), default="carbon")
    run_mode: Mapped[str] = mapped_column(String(20), default="auto")
    status: Mapped[str] = mapped_column(String(20), default="running")  # running/succeeded/failed
    inputs: Mapped[dict | None] = mapped_column(JSONB)
    results_suffix: Mapped[str | None] = mapped_column(String(100))
    outputs_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    source_snapshot_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("validation_snapshots.id", ondelete="RESTRICT"),
        unique=True,
    )

    scene: Mapped["Scene"] = relationship("Scene", back_populates="jobs")
    outputs: Mapped[list["JobOutput"]] = relationship("JobOutput", back_populates="job", cascade="all, delete-orphan")
    source_snapshot: Mapped["ValidationSnapshot | None"] = relationship(
        "ValidationSnapshot",
        back_populates="job",
    )


class ValidationSnapshot(Base):
    __tablename__ = "validation_snapshots"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    scene_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("scenes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    model_id: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    can_proceed: Mapped[bool] = mapped_column(Boolean, default=False)
    inputs: Mapped[dict] = mapped_column(JSONB, nullable=False)
    binding_report: Mapped[dict] = mapped_column(JSONB, nullable=False)
    validation: Mapped[dict] = mapped_column(JSONB, nullable=False)
    asset_fingerprints: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime)
    rejected_at: Mapped[datetime | None] = mapped_column(DateTime)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime)

    scene: Mapped["Scene"] = relationship("Scene", back_populates="validation_snapshots")
    job: Mapped["Job | None"] = relationship("Job", back_populates="source_snapshot", uselist=False)


class JobOutput(Base):
    __tablename__ = "job_outputs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # "{job_id}:{filename}"
    job_id: Mapped[str] = mapped_column(String(32), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_type: Mapped[str] = mapped_column(String(50), default="unknown")
    size: Mapped[int] = mapped_column(Integer, default=0)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    bounds: Mapped[list | None] = mapped_column(JSONB)
    bounds_wgs84: Mapped[list | None] = mapped_column(JSONB)
    crs: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    job: Mapped["Job"] = relationship("Job", back_populates="outputs")


class Skill(Base):
    __tablename__ = "skills"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    dir_path: Mapped[str] = mapped_column(Text, nullable=False)  # relative to skills_root()
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)  # single user
    username: Mapped[str] = mapped_column(String(100), default="")
    email: Mapped[str] = mapped_column(String(200), default="")
    organization: Mapped[str] = mapped_column(String(200), default="")
    research_field: Mapped[str] = mapped_column(String(200), default="")


class LlmProvider(Base):
    __tablename__ = "llm_providers"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    provider: Mapped[str] = mapped_column(String(50), default="Custom")  # OpenAI/Anthropic/…
    model_id: Mapped[str] = mapped_column(String(200), default="")
    base_url: Mapped[str] = mapped_column(Text, default="")
    api_key_enc: Mapped[str | None] = mapped_column(Text)   # Fernet-encrypted; never returned
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="untested")  # connected/untested/failed
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class AgentSession(Base):
    __tablename__ = "agent_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    scene_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("scenes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(200), default="")
    status: Mapped[str] = mapped_column(String(32), default="idle", index=True)
    domain_state: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    artifacts: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    model_config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    scene: Mapped["Scene"] = relationship("Scene", back_populates="agent_sessions")
    messages: Mapped[list["AgentMessage"]] = relationship(
        "AgentMessage",
        back_populates="session",
        cascade="all, delete-orphan",
    )
    events: Mapped[list["AgentEvent"]] = relationship(
        "AgentEvent",
        back_populates="session",
        cascade="all, delete-orphan",
    )
    confirmations: Mapped[list["AgentConfirmation"]] = relationship(
        "AgentConfirmation",
        back_populates="session",
        cascade="all, delete-orphan",
    )


class AgentMessage(Base):
    __tablename__ = "agent_messages"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("agent_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    session: Mapped["AgentSession"] = relationship("AgentSession", back_populates="messages")


class AgentEvent(Base):
    __tablename__ = "agent_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("agent_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    event_type: Mapped[str] = mapped_column(String(50), nullable=False)
    data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    session: Mapped["AgentSession"] = relationship("AgentSession", back_populates="events")


class AgentConfirmation(Base):
    __tablename__ = "agent_confirmations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("agent_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(String(50), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime)

    session: Mapped["AgentSession"] = relationship("AgentSession", back_populates="confirmations")
