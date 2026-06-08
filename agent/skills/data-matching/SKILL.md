---
name: data-matching
description: Match local data assets to InVEST model input slots using evidence and explicit uncertainty
allowed-tools:
  - list_invest_models
  - get_invest_model_schema
  - list_scene_data_cards
  - retrieve_input_candidates
  - check_data_relation
  - finalize_data_matching
  - finalize_sufficiency_assessment
  - validate_binding_report
  - confirm_validation_snapshot
  - execute_validated_snapshot
user-invocable: true
model-invocable: true
execution: inline
---

Match data to the requested InVEST model without guessing.

## Mode A: Data Exploration (explore-data / assess-sufficiency)

When the user asks "what data exists" or "can this model run":

1. Call `list_scene_data_cards` to load factual Data Cards for the current scene.
2. Call `list_invest_models` to see available models.
3. Call `get_invest_model_schema` for the target model.
4. Call `retrieve_input_candidates` for each required slot to check availability.
5. Call `finalize_sufficiency_assessment` with per-slot status (available/missing/ambiguous).
6. Call `finish` with the sufficiency report findings.

## Mode B: Data Matching (match-inputs)

When the user requests to match data or configure a run:

1. Load the authoritative model schema from GSMS.
2. Load factual Data Cards for the current GSMS scene.
3. Retrieve candidates for every required slot. Do not finalize until every required slot has a persisted candidate set.
4. Ask GSMS to compare cross-file relations when a slot declares them.
5. Keep multiple plausible candidates when evidence is ambiguous.
6. Mark missing inputs and conflicts explicitly.
7. Call `finalize_data_matching` with only slot decisions, confidence, reasoning, and unresolved questions. Never construct a Binding Report, evidence objects, relation checks, or conflicts yourself.
8. After validation passes, call `confirm_validation_snapshot` once with the exact snapshot and
   `confirmed: true`. This requests confirmation through the permission system; it does not imply
   the user has already approved. Do not repeat validation while awaiting confirmation.
9. Execute only when the current request explicitly asks for execution, and only the exact validation snapshot explicitly approved by the user.

## Evidence Gate

The `finish` tool requires at least one domain artifact to exist. You cannot finish without evidence.

- **explore-data**: needs `gsms-scene-data-cards` artifact
- **assess-sufficiency**: needs `model-input-schema` + `candidate-set` artifacts, and `sufficiency-report`
- **match-inputs**: needs `binding-report` artifact
- **validate-and-execute**: needs `validation-report` artifact

When validation fails, stop and explain the errors. Do not retry the unchanged report until the
bindings or parameters change.

Candidate scores are supporting evidence, not automatic binding decisions. Do not request execution confirmation unless GSMS validation has passed.
