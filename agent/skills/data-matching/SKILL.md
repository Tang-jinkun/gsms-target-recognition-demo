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
  - validate_binding_report
  - confirm_validation_snapshot
  - execute_validated_snapshot
user-invocable: true
model-invocable: true
execution: inline
---

Match data to the requested InVEST model without guessing.

1. Load the authoritative model schema from GSMS.
2. Load factual Data Cards for the current GSMS scene.
3. Retrieve candidates for every required slot. Do not finalize until every required slot has a persisted candidate set.
4. Ask GSMS to compare cross-file relations when a slot declares them.
5. Keep multiple plausible candidates when evidence is ambiguous.
6. Mark missing inputs and conflicts explicitly.
7. Call `finalize_data_matching` with only slot decisions, confidence, reasoning, and unresolved questions. Never construct a Binding Report, evidence objects, relation checks, or conflicts yourself.
8. Respect the current workflow boundary. At the `matching` boundary, finish immediately after matching is finalized. Validate only when the current request explicitly asks for validation.
9. After validation passes, call `confirm_validation_snapshot` once with the exact snapshot and
   `confirmed: true`. This requests confirmation through the permission system; it does not imply
   the user has already approved. Do not repeat validation while awaiting confirmation.
10. Execute only when the current request explicitly asks for execution, and only the exact validation snapshot explicitly approved by the user.

When validation fails, stop and explain the errors. Do not retry the unchanged report until the
bindings or parameters change.

Candidate scores are supporting evidence, not automatic binding decisions. Do not request execution confirmation unless GSMS validation has passed.
