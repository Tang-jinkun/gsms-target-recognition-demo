---
name: data-matching
description: Match data to InVEST model inputs or assess which models a scene can run
when_to_use: User asks about data availability, model compatibility, input matching, or "which models can run"
intent_tags:
  - match-inputs
  - assess-data-sufficiency
  - assess-runnable-models
trigger_examples:
  - 帮我匹配 Carbon 模型输入
  - 当前场景的数据能不能跑 Carbon
  - 当前场景能跑哪些模型
allowed_tools:
  - list_invest_models
  - get_invest_model_schema
  - list_scene_data_cards
  - retrieve_input_candidates
  - check_data_relation
  - finalize_data_matching
  - finalize_sufficiency_assessment
  - assess_scene_model_readiness
  - record_user_disambiguation
  - validate_binding_report
  - confirm_validation_snapshot
  - execute_validated_snapshot
user-invocable: true
model-invocable: true
execution: inline
---

Match data to the requested InVEST model without guessing.

**Critical: Always call `get_invest_model_schema` BEFORE `retrieve_input_candidates`.**
The schema tells you the exact slot names (e.g. `lulc_bas_path`, not `lulc_cur_path`).
Guessing slot names will fail and waste turns.

## Mode A: Data Exploration (explore-data / assess-sufficiency)

When the user asks "what data exists" or "can this model run":

**For a single model:**
1. Call `list_scene_data_cards` to load factual Data Cards for the current scene.
2. Call `get_invest_model_schema` for the target model — **this gives you the exact slot names**.
3. Call `retrieve_input_candidates` for each required slot listed in the schema.
4. Call `finalize_sufficiency_assessment` with per-slot status (available/missing/ambiguous).
5. Call `finish` with the sufficiency report findings.

**For "which models can run" (multi-model survey):**
1. Call `assess_scene_model_readiness` with the sceneId — this does all models in one call.
2. Call `finish` with the assessment findings. Do NOT loop over models individually.

## Mode B: Data Matching (match-inputs)

When the user requests to match data or configure a run:

1. Call `get_invest_model_schema` — **this gives you the exact slot names and constraints**.
2. Call `list_scene_data_cards` to load factual Data Cards for the current scene.
3. Retrieve candidates for every required slot. Do not finalize until every required slot has a persisted candidate set.
4. Ask GSMS to compare cross-file relations when a slot declares them.
5. **Look at the full candidate set for a slot before concluding.** Never call a slot a
   "unique match" until you have seen how many candidates it has. If two or more candidates
   tie on score, the slot is **ambiguous** — mark it `ambiguous` and ask the user which to use.
   Do not silently pick a default; the system rejects a `matched` status on a tied slot.
6. Mark missing inputs and conflicts explicitly.
7. Call `finalize_data_matching` with only slot decisions, confidence, reasoning, and unresolved questions. Never construct a Binding Report, evidence objects, relation checks, or conflicts yourself.
8. **If matching comes back `needs_review` (an unresolved ambiguity):** stop. Present the
   competing candidates to the user and ask which one to use. Do not validate, confirm, or run a
   sufficiency assessment — those tools are hidden until the ambiguity is resolved. Once the user
   chooses, call `record_user_disambiguation` with the chosen `slot` and `selectedAssetId`
   (this is gated through the permission system and creates the trustworthy user-choice record),
   then re-call `finalize_data_matching` for that slot.
9. After validation passes, call `confirm_validation_snapshot` once with the exact snapshot and
   `confirmed: true`. This requests confirmation through the permission system; it does not imply
   the user has already approved. Do not repeat validation while awaiting confirmation.
10. Execute only when the current request explicitly asks for execution, and only the exact validation snapshot explicitly approved by the user.

## Evidence Gate

The `finish` tool requires at least one domain artifact to exist. You cannot finish without evidence.

- **explore-data**: needs `gsms-scene-data-cards` artifact
- **assess-sufficiency**: needs `model-input-schema` + `candidate-set` artifacts, and `sufficiency-report`
- **match-inputs**: needs `binding-report` artifact
- **validate-and-execute**: needs `validation-report` artifact

When validation fails, stop and explain the errors. Do not retry the unchanged report until the
bindings or parameters change.

Candidate scores are supporting evidence, not automatic binding decisions. Do not request execution confirmation unless GSMS validation has passed.
