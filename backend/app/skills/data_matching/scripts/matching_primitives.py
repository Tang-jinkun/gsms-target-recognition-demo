"""
This file provides Python primitive helpers for the Data Matching Skill.
Each function corresponds to a primitive described in SKILL.md.
These are intended to be called step-by-step by the agent.
"""

def retrieve_candidates(slot_schema, asset_profiles, task_spec):
    """Retrieve candidate assets for a given model slot."""
    # TODO: implement filtering based on asset type, semantic tags, filename, metadata
    return []


def match_slot(slot_schema, candidates, task_spec):
    """Score candidates against a slot schema and return ranked list."""
    # TODO: implement scoring logic
    return []


def check_relations(slot_candidates_dict, model_schema):
    """Check cross-slot relations such as Carbon lucode coverage."""
    # TODO: implement relation checking
    return {}


def score_candidates(slot_scores, relation_results):
    """Compute overall confidence based on slot scores and relation results."""
    # TODO: implement aggregation of evidence
    return 0.0


def detect_conflicts(slot_candidates_dict, relation_results):
    """Detect missing, ambiguous, or conflicting bindings."""
    # TODO: implement conflict detection
    return []


def build_binding_report(task_spec, slot_candidates_dict, relation_results, conflicts, overall_score):
    """Assemble final Binding Report with evidence and recommendations."""
    # TODO: construct JSON report
    return {}