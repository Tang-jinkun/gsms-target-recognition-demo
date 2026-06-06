# Data Matching Skill Scripts

This directory contains optional executable helpers for the Data Matching Skill.

The scripts are not meant to replace the agent-controlled workflow described in `SKILL.md`. Instead, they provide reusable primitive implementations that an agent, API endpoint, or test harness may call step by step.

## Planned primitives

- `retrieve_candidates` — retrieve candidate assets for a model input slot
- `match_slot` — score candidate assets against a slot schema
- `check_relations` — check cross-slot rules, such as Carbon `lucode` coverage
- `score_candidates` — combine slot-level and relation-level evidence
- `detect_conflicts` — detect missing, ambiguous, or invalid bindings
- `build_binding_report` — assemble the final Binding Report

## MVP model

The first supported model is InVEST Carbon Storage and Sequestration.

Supported asset types for MVP:

- GeoTIFF raster
- CSV table

## Design note

Avoid implementing a single black-box `run_data_matching()` function as the primary interface.

The preferred API exposes small primitives so the agent can decide which step to execute next based on intermediate outputs.
