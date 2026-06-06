# Data Matching Skill Scripts

This directory contains optional executable helpers for the Data Matching Skill.

The scripts are not meant to replace the agent-controlled workflow described in `SKILL.md`. Instead, they provide reusable primitive implementations that an agent, API endpoint, or test harness may call step by step.

## Canonical entrypoint

Use `matching_primitives.py` as the canonical implementation module for the MVP.

It exposes the primitive functions described in `SKILL.md`:

- `retrieve_candidates` — retrieve candidate assets for a model input slot
- `match_slot` — score candidate assets against a slot schema
- `check_relations` — check cross-slot rules, such as Carbon `lucode` coverage
- `score_candidates` — combine slot-level and relation-level evidence
- `detect_conflicts` — detect missing, ambiguous, or invalid bindings
- `build_binding_report` — assemble the final Binding Report

## Legacy / split helper files

The files `retrieve_candidates.py` and `match_slot.py` were created as early split helper sketches. They are kept temporarily for reference, but new integration work should use `matching_primitives.py` to avoid duplicated behavior.

A later cleanup pass may either remove the split helpers or turn them into thin wrappers around `matching_primitives.py`.

## MVP model

The first supported model is InVEST Carbon Storage and Sequestration.

Supported asset types for MVP:

- GeoTIFF raster
- CSV table

## Design note

Avoid implementing a single black-box `run_data_matching()` function as the primary interface.

The preferred API exposes small primitives so the agent can decide which step to execute next based on intermediate outputs.
