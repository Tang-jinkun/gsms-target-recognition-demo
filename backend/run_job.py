import argparse
import json
import os
import sys
from pathlib import Path

from invest_models.registry import run_model_job


def log(handle, message: str) -> None:
    handle.write(f"{message}\n")
    handle.flush()


def load_job_payload(job_payload_path: Path) -> dict:
    if not job_payload_path.exists():
        return {}
    try:
        return json.loads(job_payload_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    args = parser.parse_args()

    backend_root = Path(__file__).resolve().parent
    project_root = backend_root / "data" / "projects" / "default"
    jobs_root = project_root / "jobs"
    assets_dir = project_root / "assets"

    job_dir = jobs_root / args.job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    workspace_dir = job_dir / "workspace"
    outputs_dir = job_dir / "outputs"
    log_path = job_dir / "run.log"
    job_payload_path = job_dir / "job.json"

    job_payload = load_job_payload(job_payload_path)
    job_inputs = job_payload.get("inputs") if isinstance(job_payload.get("inputs"), dict) else {}
    model_id = str(job_payload.get("modelId") or job_payload.get("model_id") or "carbon")
    run_mode = str(job_payload.get("run_mode") or os.environ.get("INVEST_RUNNER_MODE", "auto")).lower()

    with log_path.open("a", encoding="utf-8") as handle:
        try:
            log(handle, "=== job runner started ===")
            log(handle, f"model: {model_id}")
            log(handle, f"run mode: {run_mode}")
            run_model_job(
                model_id=model_id,
                job_id=args.job_id,
                job_inputs=job_inputs,
                assets_dir=assets_dir,
                workspace_dir=workspace_dir,
                outputs_dir=outputs_dir,
                run_mode=run_mode,
                handle=handle,
            )
            log(handle, "=== job runner finished ===")
            return 0
        except Exception as exc:
            log(handle, f"ERROR: {exc}")
            log(handle, "=== job runner failed ===")
            return 1


if __name__ == "__main__":
    sys.exit(main())
