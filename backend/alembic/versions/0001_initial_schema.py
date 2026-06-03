"""Initial schema: scenes, data_files, scene_imports, features, jobs,
job_outputs, skills, users, llm_providers.

Revision ID: 0001
Revises:
Create Date: 2026-06-03
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from geoalchemy2 import Geometry

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    op.create_table(
        "scenes",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("study_area", sa.String(200), nullable=False, server_default=""),
        sa.Column("note", sa.Text, nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "data_files",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("file_type", sa.String(50), nullable=False, server_default="unknown"),
        sa.Column("file_format", sa.String(50), nullable=False, server_default="unknown"),
        sa.Column("size", sa.Integer, nullable=False, server_default="0"),
        sa.Column("path", sa.Text, nullable=False),
        sa.Column("crs", sa.String(100)),
        sa.Column("bounds", JSONB),
        sa.Column("bounds_wgs84", JSONB),
        sa.Column("extra_meta", JSONB),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "scene_imports",
        sa.Column("scene_id", sa.String(32), sa.ForeignKey("scenes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("file_id", sa.String(32), sa.ForeignKey("data_files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("imported_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "features",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("file_id", sa.String(32), sa.ForeignKey("data_files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("geom", Geometry("GEOMETRY", srid=4326), nullable=False),
        sa.Column("properties", JSONB),
    )
    op.create_index("ix_features_file_id", "features", ["file_id"])
    op.execute("CREATE INDEX ix_features_geom ON features USING GIST (geom)")

    op.create_table(
        "jobs",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("scene_id", sa.String(32), sa.ForeignKey("scenes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("model_id", sa.String(100), nullable=False, server_default="carbon"),
        sa.Column("run_mode", sa.String(20), nullable=False, server_default="auto"),
        sa.Column("status", sa.String(20), nullable=False, server_default="running"),
        sa.Column("inputs", JSONB),
        sa.Column("results_suffix", sa.String(100)),
        sa.Column("outputs_count", sa.Integer, server_default="0"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("completed_at", sa.DateTime),
    )
    op.create_index("ix_jobs_scene_id", "jobs", ["scene_id"])

    op.create_table(
        "job_outputs",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("job_id", sa.String(32), sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("file_type", sa.String(50), server_default="unknown"),
        sa.Column("size", sa.Integer, server_default="0"),
        sa.Column("path", sa.Text, nullable=False),
        sa.Column("bounds", JSONB),
        sa.Column("bounds_wgs84", JSONB),
        sa.Column("crs", sa.String(100)),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )
    op.create_index("ix_job_outputs_job_id", "job_outputs", ["job_id"])

    op.create_table(
        "skills",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False, unique=True),
        sa.Column("description", sa.Text, server_default=""),
        sa.Column("dir_path", sa.Text, nullable=False),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "users",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("username", sa.String(100), server_default=""),
        sa.Column("email", sa.String(200), server_default=""),
        sa.Column("organization", sa.String(200), server_default=""),
        sa.Column("research_field", sa.String(200), server_default=""),
    )
    # Seed single user row
    op.execute("INSERT INTO users (id) VALUES (1) ON CONFLICT DO NOTHING")

    op.create_table(
        "llm_providers",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("provider", sa.String(50), server_default="Custom"),
        sa.Column("model_id", sa.String(200), server_default=""),
        sa.Column("base_url", sa.Text, server_default=""),
        sa.Column("api_key_enc", sa.Text),
        sa.Column("is_default", sa.Boolean, server_default="false"),
        sa.Column("status", sa.String(20), server_default="untested"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
    )


def downgrade() -> None:
    for t in ["llm_providers", "users", "skills", "job_outputs", "jobs",
              "features", "scene_imports", "data_files", "scenes"]:
        op.drop_table(t)
