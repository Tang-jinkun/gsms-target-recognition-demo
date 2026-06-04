"""Run Alembic migrations for container startup.

Handles the production case where the database schema was created before
Alembic version stamping existed: tables are present, but alembic_version is
missing. In that case, mark the existing schema as revision 0001, then apply
newer migrations.
"""
from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from app.db import DATABASE_URL


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", DATABASE_URL)

    engine = create_engine(DATABASE_URL)
    with engine.begin() as conn:
        inspector = inspect(conn)
        tables = set(inspector.get_table_names())
        has_version = "alembic_version" in tables
        has_initial_schema = "scenes" in tables and "data_files" in tables
        if has_initial_schema and not has_version:
            command.stamp(cfg, "0001")
        elif has_version:
            rows = conn.execute(text("SELECT version_num FROM alembic_version")).fetchall()
            if not rows and has_initial_schema:
                command.stamp(cfg, "0001")

    command.upgrade(cfg, "head")


if __name__ == "__main__":
    main()
