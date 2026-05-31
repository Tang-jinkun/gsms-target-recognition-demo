from pathlib import Path
from typing import Callable

from .carbon import MODEL_SCHEMA as CARBON_MODEL_SCHEMA
from .carbon import check_inputs as check_carbon_inputs
from .carbon import run_job as run_carbon_job
from .habitat_quality import MODEL_SCHEMA as HABITAT_QUALITY_MODEL_SCHEMA
from .habitat_quality import check_inputs as check_habitat_quality_inputs
from .habitat_quality import run_job as run_habitat_quality_job


PLANNED_MODEL_SCHEMAS = [
    {
        "id": "annual_water_yield",
        "name": "Annual Water Yield",
        "family": "Freshwater",
        "description": "Registered placeholder for future Annual Water Yield support. Schema and runner are not wired yet.",
        "status": "planned",
        "runner": None,
        "inputs": [],
        "outputs": [],
    },
    {
        "id": "sediment_delivery_ratio",
        "name": "Sediment Delivery Ratio",
        "family": "Freshwater",
        "description": "Registered placeholder for future SDR support. Schema and runner are not wired yet.",
        "status": "planned",
        "runner": None,
        "inputs": [],
        "outputs": [],
    },
]


MODEL_REGISTRY = [
    CARBON_MODEL_SCHEMA,
    HABITAT_QUALITY_MODEL_SCHEMA,
    *PLANNED_MODEL_SCHEMAS,
]


def list_model_schemas() -> list[dict]:
    return MODEL_REGISTRY


def get_model_schema(model_id: str) -> dict | None:
    for model in MODEL_REGISTRY:
        if model["id"] == model_id:
            return model
    return None


def check_model_inputs(
    model_id: str,
    inputs: dict,
    assets_dir: Path,
    read_asset_metadata: Callable[[Path], dict],
) -> dict:
    if model_id == "carbon":
        return check_carbon_inputs(inputs, assets_dir, read_asset_metadata)
    if model_id == "habitat_quality":
        return check_habitat_quality_inputs(inputs, assets_dir, read_asset_metadata)

    model = get_model_schema(model_id)
    if not model:
        raise KeyError(model_id)

    return {
        "status": "error",
        "errors": [f"{model['name']} input checking is not implemented yet."],
        "warnings": [],
        "info": ["This model is registered as a roadmap placeholder."],
        "details": {
            "model_id": model_id,
            "status": model.get("status"),
        },
    }


def run_model_job(
    model_id: str,
    job_id: str,
    job_inputs: dict,
    assets_dir: Path,
    workspace_dir: Path,
    outputs_dir: Path,
    run_mode: str,
    handle,
) -> None:
    if model_id == "carbon":
        run_carbon_job(job_id, job_inputs, assets_dir, workspace_dir, outputs_dir, run_mode, handle)
        return
    if model_id == "habitat_quality":
        run_habitat_quality_job(job_id, job_inputs, assets_dir, workspace_dir, outputs_dir, run_mode, handle)
        return

    model = get_model_schema(model_id)
    if model:
        raise ValueError(f"{model['name']} is registered but does not have a runner yet.")
    raise ValueError(f"unsupported model id: {model_id}")
