from __future__ import annotations

import hashlib
import json
from pathlib import Path

from app.files_util import file_sha256, read_geojson_file

SUPPORTED_OPERATORS = {
    "equals",
    "in",
    "contains",
    "greater-than",
    "greater-than-or-equal",
    "less-than",
    "less-than-or-equal",
}


def analysis_context_id(scene_id: str, fingerprints: dict, conditions: list[dict], version: str = "1") -> str:
    payload = json.dumps(
        {
            "sceneId": scene_id,
            "fingerprints": fingerprints,
            "conditions": conditions,
            "version": version,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def validate_conditions(profile_fields: list[dict], conditions: list[dict]) -> list[dict]:
    fields = {field["name"]: field for field in profile_fields}
    validated = []
    for condition in conditions:
        field_name = str(condition.get("field") or "")
        operator = str(condition.get("operator") or "")
        value = condition.get("value")
        if field_name not in fields:
            raise ValueError(f"Unknown target field: {field_name}")
        if operator not in SUPPORTED_OPERATORS:
            raise ValueError(f"Unsupported target operator: {operator}")
        field_type = fields[field_name].get("inferred_type")
        values = value if operator == "in" and isinstance(value, list) else [value]
        if field_type not in {"mixed", "null"} and operator in {"equals", "in"}:
            if any(property_type(item) != field_type for item in values):
                raise ValueError(f"Operator '{operator}' has a value incompatible with field {field_name}")
        if operator in {"greater-than", "greater-than-or-equal", "less-than", "less-than-or-equal"}:
            if field_type != "number" or not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ValueError(f"Numeric operator requires a numeric field and value: {field_name}")
        if operator == "in" and not isinstance(value, list):
            raise ValueError(f"Operator 'in' requires an array value: {field_name}")
        if operator == "contains" and (field_type != "string" or not isinstance(value, str)):
            raise ValueError(f"Operator 'contains' requires a string field and value: {field_name}")
        validated.append({"field": field_name, "operator": operator, "value": value})
    if not validated:
        raise ValueError("At least one target condition is required")
    return validated


def execute_target_query(
    sources: list[tuple[str, Path]],
    conditions: list[dict],
) -> dict:
    output_features = []
    total = 0
    invalid = 0
    diagnostics = []

    for asset_id, path in sources:
        collection = read_geojson_file(path)
        for feature_index, feature in enumerate(collection.get("features", [])):
            total += 1
            geometry = feature.get("geometry") or {}
            geometry_type = geometry.get("type")
            properties = feature.get("properties") or {}
            if not isinstance(properties, dict):
                invalid += 1
                diagnostics.append(f"{asset_id} feature {feature_index}: properties are not an object")
                continue
            if not all(matches_condition(properties, condition) for condition in conditions):
                continue
            if geometry_type == "Point" and valid_coordinate(geometry.get("coordinates")):
                output_features.append(with_source(feature, asset_id, feature_index))
            elif geometry_type == "MultiPoint" and isinstance(geometry.get("coordinates"), list):
                points = [point for point in geometry["coordinates"] if valid_coordinate(point)]
                if not points:
                    invalid += 1
                    diagnostics.append(f"{asset_id} feature {feature_index}: MultiPoint has no valid coordinates")
                    continue
                for point_index, point in enumerate(points):
                    output_features.append({
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": point},
                        "properties": {
                            **properties,
                            "_source_asset_id": asset_id,
                            "_source_feature_index": feature_index,
                            "_source_point_index": point_index,
                        },
                    })
            else:
                invalid += 1
                diagnostics.append(f"{asset_id} feature {feature_index}: unsupported or invalid geometry {geometry_type}")

    return {
        "totalFeatureCount": total,
        "matchedFeatureCount": len(output_features),
        "invalidFeatureCount": invalid,
        "diagnostics": diagnostics[:100],
        "geojson": {"type": "FeatureCollection", "features": output_features},
    }


def matches_condition(properties: dict, condition: dict) -> bool:
    actual = properties.get(condition["field"])
    operator = condition["operator"]
    expected = condition["value"]
    if operator == "equals":
        return actual == expected
    if operator == "in":
        return actual in expected
    if operator == "contains":
        return isinstance(actual, str) and expected in actual
    if not isinstance(actual, (int, float)) or isinstance(actual, bool):
        return False
    if operator == "greater-than":
        return actual > expected
    if operator == "greater-than-or-equal":
        return actual >= expected
    if operator == "less-than":
        return actual < expected
    if operator == "less-than-or-equal":
        return actual <= expected
    return False


def valid_coordinate(value) -> bool:
    return (
        isinstance(value, list)
        and len(value) >= 2
        and isinstance(value[0], (int, float))
        and isinstance(value[1], (int, float))
    )


def property_type(value) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "mixed"


def with_source(feature: dict, asset_id: str, feature_index: int) -> dict:
    return {
        "type": "Feature",
        "geometry": feature["geometry"],
        "properties": {
            **(feature.get("properties") or {}),
            "_source_asset_id": asset_id,
            "_source_feature_index": feature_index,
        },
    }


def source_fingerprint(path: Path) -> dict:
    return {"path": path.name, "size": path.stat().st_size, "sha256": file_sha256(path)}
