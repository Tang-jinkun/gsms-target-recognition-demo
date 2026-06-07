"""Add persisted validation snapshots and snapshot-backed jobs.

Revision ID: 0003
Revises: 0002
Create Date: 2026-06-07
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "validation_snapshots",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("scene_id", sa.String(32), sa.ForeignKey("scenes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("model_id", sa.String(100), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("can_proceed", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("inputs", JSONB, nullable=False),
        sa.Column("binding_report", JSONB, nullable=False),
        sa.Column("validation", JSONB, nullable=False),
        sa.Column("asset_fingerprints", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("confirmed_at", sa.DateTime),
        sa.Column("rejected_at", sa.DateTime),
        sa.Column("consumed_at", sa.DateTime),
    )
    op.create_index("ix_validation_snapshots_scene_id", "validation_snapshots", ["scene_id"])
    op.add_column("jobs", sa.Column("source_snapshot_id", sa.String(64), nullable=True))
    op.create_unique_constraint("uq_jobs_source_snapshot_id", "jobs", ["source_snapshot_id"])
    op.create_foreign_key(
        "fk_jobs_source_snapshot_id_validation_snapshots",
        "jobs",
        "validation_snapshots",
        ["source_snapshot_id"],
        ["id"],
        ondelete="RESTRICT",
    )


def downgrade() -> None:
    op.drop_constraint("fk_jobs_source_snapshot_id_validation_snapshots", "jobs", type_="foreignkey")
    op.drop_constraint("uq_jobs_source_snapshot_id", "jobs", type_="unique")
    op.drop_column("jobs", "source_snapshot_id")
    op.drop_index("ix_validation_snapshots_scene_id", table_name="validation_snapshots")
    op.drop_table("validation_snapshots")
