---
name: data-matching
version: 0.1.0
description: |
  Provides schema-guided data matching primitives for geospatial models (e.g., InVEST Carbon).
  Guides agents on recommended workflow to bind project assets to model input slots.
---

# Data Matching Skill

## Purpose

This skill defines the standard workflow for matching project assets to model input slots for geospatial analysis models. The agent reads this skill to understand the recommended sequence of operations, evidence collection, and output contract.

## Workflow Overview

Recommended agent-controlled workflow:
1. Confirm model context
2. Load Model Input Schema
3. Load project asset profiles (Data Cards)
4. Identify required input slots
5. If scene data is empty or insufficient, discover Data Hub candidates and ask the user to confirm importing file references
6. Retrieve candidate assets for each slot
7. Match candidates to slots
8. Check cross-slot relations
9. Score candidate bindings
10. Detect missing, ambiguous, or conflicting inputs
11. Decide next action (auto-bind, needs review, request upload, stop)
12. Build Binding Report
13. Hand off to validation or configuration

## Agent Guidance

- The agent decides which primitive to call and the order based on Task Spec and intermediate results.
- Skill provides primitives, each with input/output contract, but does not control execution sequence.
- The agent must handle retries, warnings, human confirmation, or upload requests.
- When current-scene Data Cards are empty or required slots have no candidates, the agent must check global Data Hub discovery before declaring data missing.
- Data Hub imports are by reference only and require explicit user confirmation.

## Required Inputs

- **Task Spec**: describes user request and scenario
- **Model Input Schema**: required/optional slots, constraints, relations
- **Data Cards / Asset Profiles**: metadata and semantic tags for project assets

## Primitives

1. `retrieve_candidates` - retrieves candidate assets for a slot
2. `match_slot` - evaluates how well each candidate fits the slot
3. `check_relations` - checks relations across multiple slots
4. `score_candidates` - assigns confidence scores
5. `detect_conflicts` - identifies missing, ambiguous, or conflicting inputs
6. `build_binding_report` - produces structured Binding Report with evidence and recommendations

## Outputs

- **Binding Report**: structured report detailing slot bindings, confidence scores, evidence, conflicts, missing inputs, ambiguous slots, and recommended next action

## Example Usage

- Agent requests Data Matching Skill for `invest_carbon`
- Skill guides agent through retrieving candidates, scoring, and building report
- Agent interprets Binding Report to decide whether to auto-bind, ask user confirmation, request data upload, or stop

## Design Principle

- Explicit, explainable, auditable, reusable, and safe.
- Skill defines *what* to do at each step; agent decides *how* and *when* to execute.
- Focus on schema-driven data matching; execution and model run remain agent responsibilities.
