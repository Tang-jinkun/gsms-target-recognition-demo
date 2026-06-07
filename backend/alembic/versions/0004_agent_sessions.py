"""Add persisted Agent sessions, messages, events, and confirmations.

Revision ID: 0004
Revises: 0003
Create Date: 2026-06-07
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_sessions",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("scene_id", sa.String(32), sa.ForeignKey("scenes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False, server_default=""),
        sa.Column("status", sa.String(32), nullable=False, server_default="idle"),
        sa.Column("domain_state", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("artifacts", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("model_config", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("last_error", sa.Text),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
    )
    op.create_index("ix_agent_sessions_scene_id", "agent_sessions", ["scene_id"])
    op.create_index("ix_agent_sessions_status", "agent_sessions", ["status"])

    op.create_table(
        "agent_messages",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("session_id", sa.String(32), sa.ForeignKey("agent_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("metadata_json", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )
    op.create_index("ix_agent_messages_session_id", "agent_messages", ["session_id"])

    op.create_table(
        "agent_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("session_id", sa.String(32), sa.ForeignKey("agent_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_type", sa.String(50), nullable=False),
        sa.Column("data", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )
    op.create_index("ix_agent_events_session_id", "agent_events", ["session_id"])

    op.create_table(
        "agent_confirmations",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("session_id", sa.String(32), sa.ForeignKey("agent_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(50), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("prompt", sa.Text, nullable=False),
        sa.Column("payload", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("resolved_at", sa.DateTime),
    )
    op.create_index("ix_agent_confirmations_session_id", "agent_confirmations", ["session_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_confirmations_session_id", table_name="agent_confirmations")
    op.drop_table("agent_confirmations")
    op.drop_index("ix_agent_events_session_id", table_name="agent_events")
    op.drop_table("agent_events")
    op.drop_index("ix_agent_messages_session_id", table_name="agent_messages")
    op.drop_table("agent_messages")
    op.drop_index("ix_agent_sessions_status", table_name="agent_sessions")
    op.drop_index("ix_agent_sessions_scene_id", table_name="agent_sessions")
    op.drop_table("agent_sessions")
