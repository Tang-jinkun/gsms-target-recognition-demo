"""Database engine and session factory.

DATABASE_URL defaults to a local Postgres for dev; set the env var in
docker-compose for production.
"""
import os
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+psycopg2://gsms:gsms@localhost:5432/gsms",
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create all tables and ensure PostGIS extension exists."""
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
    from app import models as _  # noqa: F401 — register all ORM models
    Base.metadata.create_all(bind=engine)
