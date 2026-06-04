"""Add Data Hub folders.

Revision ID: 0002
Revises: 0001
Create Date: 2026-06-04
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


UNCATEGORIZED_ID = "uncategorized"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    tables = set(inspector.get_table_names())
    if "data_folders" not in tables:
        op.create_table(
            "data_folders",
            sa.Column("id", sa.String(32), primary_key=True),
            sa.Column("name", sa.String(200), nullable=False, unique=True),
            sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
        )

    data_file_columns = {col["name"] for col in inspector.get_columns("data_files")}
    if "folder_id" not in data_file_columns:
        op.add_column("data_files", sa.Column("folder_id", sa.String(32), nullable=True))

    indexes = {idx["name"] for idx in inspector.get_indexes("data_files")}
    if "ix_data_files_folder_id" not in indexes:
        op.create_index("ix_data_files_folder_id", "data_files", ["folder_id"])

    foreign_keys = {fk["name"] for fk in inspector.get_foreign_keys("data_files")}
    if "fk_data_files_folder_id_data_folders" not in foreign_keys:
        op.create_foreign_key(
            "fk_data_files_folder_id_data_folders",
            "data_files",
            "data_folders",
            ["folder_id"],
            ["id"],
            ondelete="SET NULL",
        )
    op.execute(
        "INSERT INTO data_folders (id, name) "
        f"VALUES ('{UNCATEGORIZED_ID}', '未分类') "
        "ON CONFLICT (id) DO NOTHING"
    )
    op.execute(f"UPDATE data_files SET folder_id = '{UNCATEGORIZED_ID}' WHERE folder_id IS NULL")


def downgrade() -> None:
    inspector = inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "data_files" in tables:
        foreign_keys = {fk["name"] for fk in inspector.get_foreign_keys("data_files")}
        if "fk_data_files_folder_id_data_folders" in foreign_keys:
            op.drop_constraint("fk_data_files_folder_id_data_folders", "data_files", type_="foreignkey")
        indexes = {idx["name"] for idx in inspector.get_indexes("data_files")}
        if "ix_data_files_folder_id" in indexes:
            op.drop_index("ix_data_files_folder_id", table_name="data_files")
        data_file_columns = {col["name"] for col in inspector.get_columns("data_files")}
        if "folder_id" in data_file_columns:
            op.drop_column("data_files", "folder_id")
    if "data_folders" in tables:
        op.drop_table("data_folders")
