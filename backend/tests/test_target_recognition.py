from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.files_util import build_vector_property_profile
from app.target_recognition import execute_target_query, validate_conditions


SAMPLES = Path(__file__).parents[2] / "sample_data" / "target-recognition"


def profile(path: Path) -> dict:
    return build_vector_property_profile(json.loads(path.read_text(encoding="utf-8"))["features"])


def test_property_profile_exposes_bounded_factual_catalog():
    result = profile(SAMPLES / "urban_flood_points_2026-06-10.geojson")
    fields = {field["name"]: field for field in result["fields"]}

    assert result["feature_count"] == 22
    assert result["geometry_types"] == {"Point": 22}
    assert "积水点" in fields["point_type"]["sampled_values"]
    assert fields["measured_value"]["inferred_type"] == "number"
    assert fields["measured_value"]["numeric_stats"]["minimum"] <= fields["measured_value"]["numeric_stats"]["maximum"]


@pytest.mark.parametrize(("date", "expected"), [("2026-06-08", 6), ("2026-06-09", 7), ("2026-06-10", 8)])
def test_generic_queries_match_expected_waterlogging_counts(date: str, expected: int):
    source = SAMPLES / f"urban_flood_points_{date}.geojson"
    fields = profile(source)["fields"]
    conditions = validate_conditions(fields, [{"field": "point_type", "operator": "equals", "value": "积水点"}])
    result = execute_target_query([("latest", source)], conditions)

    assert result["matchedFeatureCount"] == expected
    assert all(feature["geometry"]["type"] == "Point" for feature in result["geojson"]["features"])


def test_generic_query_matches_latest_rain_gauges():
    source = SAMPLES / "urban_flood_points_2026-06-10.geojson"
    result = execute_target_query(
        [("latest", source)],
        [{"field": "point_type", "operator": "equals", "value": "雨量站"}],
    )
    assert result["matchedFeatureCount"] == 4


def test_numeric_and_query_is_deterministic():
    source = SAMPLES / "urban_flood_points_2026-06-10.geojson"
    fields = profile(source)["fields"]
    conditions = validate_conditions(fields, [
        {"field": "point_type", "operator": "equals", "value": "积水点"},
        {"field": "risk_level", "operator": "equals", "value": "高"},
        {"field": "value_unit", "operator": "equals", "value": "cm"},
        {"field": "measured_value", "operator": "greater-than", "value": 30},
    ])

    first = execute_target_query([("latest", source)], conditions)
    second = execute_target_query([("latest", source)], conditions)
    assert first == second
    assert first["matchedFeatureCount"] > 0


def test_multipoint_is_exploded_and_non_point_is_diagnostic(tmp_path: Path):
    source = tmp_path / "mixed.geojson"
    source.write_text(json.dumps({
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": {"type": "MultiPoint", "coordinates": [[1, 2], [3, 4]]}, "properties": {"kind": "target"}},
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[1, 2], [3, 4]]}, "properties": {"kind": "target"}},
        ],
    }), encoding="utf-8")

    result = execute_target_query([("mixed", source)], [{"field": "kind", "operator": "equals", "value": "target"}])
    assert result["matchedFeatureCount"] == 2
    assert result["invalidFeatureCount"] == 1


def test_invalid_field_and_operator_are_rejected():
    fields = profile(SAMPLES / "urban_flood_points_2026-06-10.geojson")["fields"]
    with pytest.raises(ValueError, match="Unknown target field"):
        validate_conditions(fields, [{"field": "made_up", "operator": "equals", "value": "x"}])
    with pytest.raises(ValueError, match="Numeric operator"):
        validate_conditions(fields, [{"field": "status", "operator": "greater-than", "value": 1}])
    with pytest.raises(ValueError, match="incompatible"):
        validate_conditions(fields, [{"field": "measured_value", "operator": "equals", "value": "30"}])
    with pytest.raises(ValueError, match="string field"):
        validate_conditions(fields, [{"field": "measured_value", "operator": "contains", "value": "3"}])
