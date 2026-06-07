---
name: data-matching
description: Match local data assets to InVEST model input slots using evidence and explicit uncertainty
allowed-tools:
  - list_invest_models
  - get_invest_model_schema
  - list_scene_data_cards
  - retrieve_input_candidates
  - check_data_relation
  - submit_binding_report
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
3. Retrieve candidates for every relevant required slot.
4. Ask GSMS to compare cross-file relations when a slot declares them.
5. Keep multiple plausible candidates when evidence is ambiguous.
6. Mark missing inputs and conflicts explicitly.
7. Submit a Binding Report containing facts, agent reasoning, unresolved questions, and the recommended next action.
8. When the report can proceed, ask GSMS to validate it before requesting user confirmation.
9. After validation passes, call `confirm_validation_snapshot` once with the exact snapshot and
   `confirmed: true`. This requests confirmation through the permission system; it does not imply
   the user has already approved. Do not repeat validation while awaiting confirmation.
10. Execute only the exact validation snapshot explicitly approved by the user.

When validation fails, stop and explain the errors. Do not retry the unchanged report until the
bindings or parameters change.

Candidate scores are supporting evidence, not automatic binding decisions. Do not request execution confirmation unless GSMS validation has passed.
