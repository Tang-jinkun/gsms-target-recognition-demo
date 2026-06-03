"""Filesystem path helpers.

Replaces the hard-coded ASSETS_DIR / JOBS_DIR globals in the old main.py.
Everything under DATA_ROOT; callers use these functions instead of raw paths.
"""
import os
from pathlib import Path

DATA_ROOT = Path(os.environ.get("DATA_ROOT", Path(__file__).resolve().parents[1] / "data"))


# ── Global Data Hub ────────────────────────────────────────────────────────────

def project_files_dir() -> Path:
    d = DATA_ROOT / "project" / "files"
    d.mkdir(parents=True, exist_ok=True)
    return d


def project_file_previews_dir() -> Path:
    d = DATA_ROOT / "project" / "file_previews"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── Scenes ─────────────────────────────────────────────────────────────────────

def scene_dir(scene_id: str) -> Path:
    d = DATA_ROOT / "scenes" / _safe(scene_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def scene_jobs_dir(scene_id: str) -> Path:
    d = scene_dir(scene_id) / "jobs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def scene_job_dir(scene_id: str, job_id: str) -> Path:
    d = scene_jobs_dir(scene_id) / _safe(job_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def scene_outputs_dir(scene_id: str) -> Path:
    d = scene_dir(scene_id) / "outputs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def scene_job_outputs_dir(scene_id: str, job_id: str) -> Path:
    """Per-job output folder inside scene outputs."""
    d = scene_outputs_dir(scene_id) / _safe(job_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def scene_output_previews_dir(scene_id: str) -> Path:
    d = scene_dir(scene_id) / "output_previews"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── Skills ─────────────────────────────────────────────────────────────────────

def skills_root() -> Path:
    d = DATA_ROOT / "skills"
    d.mkdir(parents=True, exist_ok=True)
    return d


def skill_dir(skill_id: str) -> Path:
    d = skills_root() / _safe(skill_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── Legacy alias (for run_job.py compatibility during migration) ───────────────

def legacy_assets_dir() -> Path:
    """Old flat assets dir; kept for run_job.py until fully migrated."""
    d = DATA_ROOT / "projects" / "default" / "assets"
    d.mkdir(parents=True, exist_ok=True)
    return d


def legacy_jobs_dir() -> Path:
    d = DATA_ROOT / "projects" / "default" / "jobs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe(name: str) -> str:
    """Strip path separators to prevent directory traversal."""
    return Path(name).name
