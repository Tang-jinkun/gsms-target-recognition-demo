"""
Canonical Python primitive helpers for the Data Matching Skill.

These functions are intentionally small and composable. They should be called
step-by-step by an agent, API endpoint, or test harness. Do not treat this file
as a black-box workflow runner.

Inputs are plain dictionaries so the helpers can work with existing Asset
Profile / Data Card objects before the project has a stronger typed model layer.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

AssetProfile = Dict[str, Any]
SlotSchema = Dict[str, Any]
TaskSpec = Dict[str, Any]
ModelSchema = Dict[str, Any]


LULC_FILENAME_HINTS = ("lulc", "landuse", "land_use", "landcover", "land_cover")
CARBON_TABLE_FILENAME_HINTS = ("carbon", "carbon_pool", "carbon_pools")
AMBIGUITY_DELTA = 0.05
AUTO_BIND_THRESHOLD = 0.85
REVIEW_THRESHOLD = 0.60


def _normalize_text(value: Any) -> str:
    return str(value or "").strip().lower()


def _as_list(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def _asset_type(asset: AssetProfile) -> str:
    return _normalize_text(asset.get("asset_type") or asset.get("type"))


def _slot_type(slot_schema: SlotSchema) -> str:
    return _normalize_text(slot_schema.get("asset_type") or slot_schema.get("type"))


def _semantic_tags(asset: AssetProfile) -> List[str]:
    return [_normalize_text(tag) for tag in _as_list(asset.get("semantic_tags"))]


def _semantic_roles(slot_schema: SlotSchema) -> List[str]:
    return [_normalize_text(tag) for tag in _as_list(slot_schema.get("semantic_roles"))]


def _filename(asset: AssetProfile) -> str:
    return _normalize_text(asset.get("filename") or asset.get("name") or Path(str(asset.get("path", ""))).name)


def _metadata(asset: AssetProfile) -> Dict[str, Any]:
    metadata = asset.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _columns(asset: AssetProfile) -> List[str]:
    return [_normalize_text(col) for col in _as_list(_metadata(asset).get("columns"))]


def _required_columns(slot_schema: SlotSchema) -> List[str]:
    return [_normalize_text(col) for col in _as_list(slot_schema.get("required_columns"))]


def _asset_id(asset: AssetProfile) -> str:
    return str(asset.get("asset_id") or asset.get("id") or asset.get("path") or asset.get("filename") or "unknown_asset")


def _filename_matches_roles(filename: str, roles: Sequence[str]) -> bool:
    role_tokens = set(roles)
    if role_tokens.intersection({"lulc", "landuse", "landcover"}):
        return any(token in filename for token in LULC_FILENAME_HINTS)
    if role_tokens.intersection({"carbon_pool_table", "carbon_table", "biophysical_table"}):
        return any(token in filename for token in CARBON_TABLE_FILENAME_HINTS)
    return any(role and role in filename for role in roles)


def retrieve_candidates(slot_schema: SlotSchema, asset_profiles: Sequence[AssetProfile], task_spec: Optional[TaskSpec] = None) -> Dict[str, Any]:
    """Retrieve candidate assets for a given model slot.

    Candidate retrieval is intentionally permissive: exact asset type matches are
    preferred, but assets with incomplete metadata can still be returned with
    warnings so the agent may decide whether to profile, ask the user, or retry.
    """
    slot_name = slot_schema.get("name") or slot_schema.get("slot") or slot_schema.get("slot_name")
    expected_type = _slot_type(slot_schema)
    roles = _semantic_roles(slot_schema)
    candidates: List[Dict[str, Any]] = []

    for asset in asset_profiles:
        reasons: List[str] = []
        warnings: List[str] = []
        asset_type = _asset_type(asset)
        filename = _filename(asset)
        tags = _semantic_tags(asset)
        metadata = _metadata(asset)

        if expected_type and asset_type != expected_type:
            continue

        if expected_type:
            reasons.append(f"asset_type matches {expected_type}")

        semantic_match = bool(set(tags).intersection(roles)) if roles else False
        filename_match = _filename_matches_roles(filename, roles)
        schema_hint_match = False

        if expected_type == "table" and _required_columns(slot_schema):
            present = set(_columns(asset))
            required = set(_required_columns(slot_schema))
            schema_hint_match = required.issubset(present)
            if schema_hint_match:
                reasons.append("required columns are present")

        if semantic_match:
            reasons.append("semantic_tags match slot roles")
        if filename_match:
            reasons.append("filename matches expected role")
        if metadata:
            reasons.append("metadata is available")
        else:
            warnings.append("metadata is missing or empty")

        # Keep candidates that match type and have at least one non-type signal.
        if semantic_match or filename_match or schema_hint_match or metadata:
            candidates.append({
                "asset_id": _asset_id(asset),
                "asset": asset,
                "retrieval_reasons": reasons,
                "warnings": warnings,
            })

    return {
        "slot": slot_name,
        "candidates": candidates,
        "warnings": [] if candidates else ["no candidate assets found"],
    }


def match_slot(slot_schema: SlotSchema, candidates: Sequence[Dict[str, Any]], task_spec: Optional[TaskSpec] = None) -> Dict[str, Any]:
    """Score candidates against a slot schema and return a ranked list."""
    slot_name = slot_schema.get("name") or slot_schema.get("slot") or slot_schema.get("slot_name")
    expected_type = _slot_type(slot_schema)
    roles = _semantic_roles(slot_schema)
    required_columns = set(_required_columns(slot_schema))
    ranked: List[Dict[str, Any]] = []

    for candidate in candidates:
        asset = candidate.get("asset", candidate)
        metadata = _metadata(asset)
        filename = _filename(asset)
        tags = _semantic_tags(asset)
        asset_type = _asset_type(asset)
        evidence: List[str] = list(candidate.get("retrieval_reasons", []))
        warnings: List[str] = list(candidate.get("warnings", []))
        hard_failures: List[str] = []

        type_score = 1.0 if expected_type and asset_type == expected_type else 0.0
        if type_score == 0.0:
            hard_failures.append(f"asset_type mismatch: expected {expected_type}, got {asset_type or 'unknown'}")

        semantic_score = 0.0
        if roles:
            if set(tags).intersection(roles):
                semantic_score = max(semantic_score, 1.0)
                if "semantic_tags match slot roles" not in evidence:
                    evidence.append("semantic_tags match slot roles")
            if _filename_matches_roles(filename, roles):
                semantic_score = max(semantic_score, 0.8)
                if "filename matches expected role" not in evidence:
                    evidence.append("filename matches expected role")

        metadata_score = 1.0 if metadata else 0.0
        if not metadata:
            warnings.append("metadata is missing")

        schema_score = 0.0
        content_score = 0.0

        if expected_type == "raster":
            band_count = metadata.get("band_count")
            dtypes = [_normalize_text(dtype) for dtype in _as_list(metadata.get("dtypes") or metadata.get("dtype"))]
            if band_count == 1:
                schema_score += 0.4
                evidence.append("band_count is 1")
            elif band_count is not None:
                warnings.append(f"band_count is {band_count}; single-band raster is preferred")
            if metadata.get("crs"):
                schema_score += 0.3
                evidence.append("crs is present")
            else:
                warnings.append("crs is missing")
            if metadata.get("bounds"):
                schema_score += 0.1
                evidence.append("bounds are present")
            integer_like = any(dtype.startswith(("int", "uint")) for dtype in dtypes)
            if integer_like:
                content_score += 1.0
                evidence.append("dtype suggests categorical integer raster")
            elif dtypes:
                warnings.append("dtype does not look like an integer categorical raster")
            schema_score = min(schema_score, 1.0)

        elif expected_type == "table":
            present_columns = set(_columns(asset))
            if required_columns:
                missing = sorted(required_columns.difference(present_columns))
                if not missing:
                    schema_score = 1.0
                    content_score = 1.0
                    evidence.append("all required columns are present")
                else:
                    schema_score = max(0.0, 1.0 - len(missing) / max(len(required_columns), 1))
                    hard_failures.append(f"missing required columns: {', '.join(missing)}")
            else:
                schema_score = 0.5 if present_columns else 0.0

        score = (
            0.25 * type_score
            + 0.25 * schema_score
            + 0.20 * semantic_score
            + 0.15 * metadata_score
            + 0.15 * content_score
        )

        ranked.append({
            "asset_id": _asset_id(asset),
            "score": round(score, 4),
            "score_components": {
                "type_score": round(type_score, 4),
                "schema_score": round(schema_score, 4),
                "semantic_score": round(semantic_score, 4),
                "metadata_score": round(metadata_score, 4),
                "content_score": round(content_score, 4),
            },
            "evidence": sorted(set(evidence)),
            "warnings": sorted(set(warnings)),
            "hard_failures": hard_failures,
            "asset": asset,
        })

    ranked.sort(key=lambda item: item["score"], reverse=True)
    return {
        "slot": slot_name,
        "ranked_candidates": ranked,
    }


def _lookup_asset(match_result: Dict[str, Any], asset_id: str) -> Optional[AssetProfile]:
    for candidate in match_result.get("ranked_candidates", []):
        if candidate.get("asset_id") == asset_id:
            return candidate.get("asset")
    return None


def _top_candidate(match_result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    candidates = match_result.get("ranked_candidates", [])
    return candidates[0] if candidates else None


def _metadata_values(asset: AssetProfile, keys: Iterable[str]) -> List[Any]:
    metadata = _metadata(asset)
    for key in keys:
        value = metadata.get(key)
        if value is not None:
            return _as_list(value)
    return []


def check_relations(slot_matches: Dict[str, Dict[str, Any]], model_schema: ModelSchema) -> List[Dict[str, Any]]:
    """Check cross-slot relations such as Carbon lucode coverage.

    The function currently supports `table_column_should_cover_raster_values`.
    It expects LULC unique values to be available in raster metadata under one of:
    `unique_values`, `unique_values_sample`, or `sampled_unique_values`.
    """
    results: List[Dict[str, Any]] = []

    for relation in model_schema.get("relations", []):
        relation_type = relation.get("type")
        relation_id = relation.get("id", relation_type or "relation")

        if relation_type != "table_column_should_cover_raster_values":
            results.append({
                "relation_id": relation_id,
                "status": "not_checked",
                "evidence": [f"unsupported relation type: {relation_type}"],
                "warnings": ["relation type is not implemented in MVP"],
                "details": {},
            })
            continue

        raster_slot = relation.get("raster_slot")
        table_slot = relation.get("table_slot")
        table_column = _normalize_text(relation.get("table_column"))
        raster_match = slot_matches.get(raster_slot, {})
        table_match = slot_matches.get(table_slot, {})
        raster_top = _top_candidate(raster_match)
        table_top = _top_candidate(table_match)

        if not raster_top or not table_top:
            results.append({
                "relation_id": relation_id,
                "status": "not_checked",
                "evidence": ["required top candidates are missing"],
                "warnings": ["relation could not be checked because one or more slots are unresolved"],
                "details": {},
            })
            continue

        raster_asset = raster_top.get("asset")
        table_asset = table_top.get("asset")
        raster_values = _metadata_values(raster_asset, ("unique_values", "unique_values_sample", "sampled_unique_values"))
        table_rows = _metadata(table_asset).get("rows") or _metadata(table_asset).get("sample_rows") or []
        table_values: List[Any] = []

        if isinstance(table_rows, list) and table_rows:
            for row in table_rows:
                if isinstance(row, dict) and table_column in {_normalize_text(k) for k in row.keys()}:
                    for key, value in row.items():
                        if _normalize_text(key) == table_column:
                            table_values.append(value)

        # Some profiles may store column values directly.
        if not table_values:
            direct_values = _metadata(table_asset).get(f"{table_column}_values") or _metadata(table_asset).get("lucode_values")
            table_values = _as_list(direct_values)

        if not raster_values or not table_values:
            results.append({
                "relation_id": relation_id,
                "status": "not_checked",
                "evidence": ["LULC unique values or table lucode values are unavailable in metadata"],
                "warnings": ["could not verify table coverage of raster class values"],
                "details": {},
            })
            continue

        raster_set = {_normalize_text(value) for value in raster_values if value is not None}
        table_set = {_normalize_text(value) for value in table_values if value is not None}
        missing = sorted(raster_set.difference(table_set))

        if missing:
            results.append({
                "relation_id": relation_id,
                "status": "failed",
                "evidence": ["sampled raster values include codes not present in the table column"],
                "warnings": [],
                "details": {"missing_codes": missing},
            })
        else:
            results.append({
                "relation_id": relation_id,
                "status": "passed",
                "evidence": ["table column covers sampled raster values"],
                "warnings": [],
                "details": {},
            })

    return results


def score_candidates(slot_matches: Dict[str, Dict[str, Any]], relation_results: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute overall confidence from top slot candidates and relation checks."""
    top_scores: List[float] = []
    decision_reasons: List[str] = []

    for slot_name, match_result in slot_matches.items():
        top = _top_candidate(match_result)
        if not top:
            decision_reasons.append(f"slot {slot_name} has no candidate")
            continue
        top_scores.append(float(top.get("score", 0.0)))
        if top.get("hard_failures"):
            decision_reasons.append(f"slot {slot_name} has hard failures")

    overall = sum(top_scores) / len(top_scores) if top_scores else 0.0

    for relation in relation_results:
        status = relation.get("status")
        if status == "failed":
            overall -= 0.25
            decision_reasons.append(f"relation {relation.get('relation_id')} failed")
        elif status == "not_checked":
            overall -= 0.10
            decision_reasons.append(f"relation {relation.get('relation_id')} was not checked")

    overall = max(0.0, min(1.0, overall))
    if overall >= AUTO_BIND_THRESHOLD and not any(rel.get("status") == "failed" for rel in relation_results):
        decision = "auto_bound"
    elif overall >= REVIEW_THRESHOLD:
        decision = "needs_review"
    else:
        decision = "failed"

    return {
        "overall_confidence": round(overall, 4),
        "decision": decision,
        "decision_reasons": decision_reasons,
    }


def detect_conflicts(slot_matches: Dict[str, Dict[str, Any]], relation_results: Sequence[Dict[str, Any]], model_schema: Optional[ModelSchema] = None) -> Dict[str, Any]:
    """Detect missing, ambiguous, or conflicting bindings."""
    conflicts: List[Dict[str, Any]] = []
    missing_required_inputs: List[Dict[str, Any]] = []
    ambiguous_inputs: List[Dict[str, Any]] = []

    required_slots: List[str] = []
    if model_schema:
        for slot_name, slot_schema in model_schema.get("slots", {}).items():
            if slot_schema.get("required") and not slot_schema.get("system_generated"):
                required_slots.append(slot_name)
    else:
        required_slots = list(slot_matches.keys())

    for slot_name in required_slots:
        match_result = slot_matches.get(slot_name, {})
        ranked = match_result.get("ranked_candidates", [])
        if not ranked:
            missing_required_inputs.append({"slot": slot_name, "expected": "model-compatible project asset"})
            conflicts.append({
                "type": "missing_required_input",
                "slot": slot_name,
                "message": f"No candidate was found for required slot {slot_name}.",
            })
            continue

        top = ranked[0]
        if top.get("hard_failures"):
            conflicts.append({
                "type": "hard_constraint_failure",
                "slot": slot_name,
                "message": "; ".join(top.get("hard_failures", [])),
            })

        if len(ranked) > 1 and float(top.get("score", 0.0)) - float(ranked[1].get("score", 0.0)) <= AMBIGUITY_DELTA:
            ambiguous_inputs.append({
                "slot": slot_name,
                "candidates": [
                    {"asset_id": item.get("asset_id"), "score": item.get("score")}
                    for item in ranked[:3]
                ],
                "reason": "top candidates have similar scores",
            })
            conflicts.append({
                "type": "ambiguous_candidates",
                "slot": slot_name,
                "message": f"Multiple candidates for {slot_name} have similar scores.",
            })

    for relation in relation_results:
        if relation.get("status") == "failed":
            conflicts.append({
                "type": "relation_failure",
                "slot": relation.get("table_slot") or "relation",
                "message": f"Relation {relation.get('relation_id')} failed.",
            })
        elif relation.get("status") == "not_checked":
            conflicts.append({
                "type": "metadata_incomplete",
                "slot": "relation",
                "message": f"Relation {relation.get('relation_id')} could not be checked.",
            })

    return {
        "missing_required_inputs": missing_required_inputs,
        "ambiguous_inputs": ambiguous_inputs,
        "conflicts": conflicts,
    }


def build_binding_report(
    task_spec: TaskSpec,
    model_schema: ModelSchema,
    slot_matches: Dict[str, Dict[str, Any]],
    relation_results: Sequence[Dict[str, Any]],
    conflict_result: Dict[str, Any],
    score_result: Dict[str, Any],
) -> Dict[str, Any]:
    """Assemble a final Binding Report."""
    bindings: Dict[str, Any] = {}

    for slot_name, match_result in slot_matches.items():
        top = _top_candidate(match_result)
        if not top:
            bindings[slot_name] = {
                "asset_id": None,
                "decision": "missing",
                "score": 0.0,
                "evidence": [],
                "warnings": ["no candidate found"],
            }
            continue

        decision = "selected" if not top.get("hard_failures") else "candidate"
        bindings[slot_name] = {
            "asset_id": top.get("asset_id"),
            "decision": decision,
            "score": top.get("score", 0.0),
            "evidence": top.get("evidence", []),
            "warnings": top.get("warnings", []),
        }

    status = score_result.get("decision", "failed")
    conflicts = conflict_result.get("conflicts", [])
    if any(conflict.get("type") in {"missing_required_input", "hard_constraint_failure", "relation_failure"} for conflict in conflicts):
        status = "failed"
    elif conflicts and status == "auto_bound":
        status = "needs_review"

    recommended_next_action = "proceed_to_validation"
    if status == "failed":
        if any(conflict.get("type") == "missing_required_input" for conflict in conflicts):
            recommended_next_action = "ask_user_to_upload_data"
        else:
            recommended_next_action = "stop_and_explain"
    elif status == "needs_review":
        recommended_next_action = "ask_user_to_confirm"

    project_id = task_spec.get("project_id", "default")
    model_id = task_spec.get("model_id") or model_schema.get("model_id")

    return {
        "report_id": f"match_{project_id}_{model_id}_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
        "project_id": project_id,
        "model_id": model_id,
        "status": status,
        "overall_confidence": score_result.get("overall_confidence", 0.0),
        "bindings": bindings,
        "relations": list(relation_results),
        "missing_required_inputs": conflict_result.get("missing_required_inputs", []),
        "ambiguous_inputs": conflict_result.get("ambiguous_inputs", []),
        "conflicts": conflicts,
        "recommended_next_action": recommended_next_action,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
