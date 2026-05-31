from .carbon import MODEL_SCHEMA as CARBON_MODEL_SCHEMA


PLANNED_MODEL_SCHEMAS = [
    {
        "id": "habitat_quality",
        "name": "Habitat Quality",
        "family": "Terrestrial",
        "description": "Registered placeholder for future Habitat Quality support. Schema and runner are not wired yet.",
        "status": "planned",
        "runner": None,
        "inputs": [],
        "outputs": [],
    },
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
    *PLANNED_MODEL_SCHEMAS,
]


def list_model_schemas() -> list[dict]:
    return MODEL_REGISTRY


def get_model_schema(model_id: str) -> dict | None:
    for model in MODEL_REGISTRY:
        if model["id"] == model_id:
            return model
    return None
