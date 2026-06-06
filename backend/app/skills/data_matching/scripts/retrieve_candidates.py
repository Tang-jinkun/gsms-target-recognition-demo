"""
Primitive helper for retrieving candidate assets for a model input slot.
"""

def retrieve_candidates(slot_schema, asset_profiles, task_spec):
    """Retrieve candidate assets for a given model slot based on type, semantic tags, filename, and metadata."""
    candidates = []
    for asset in asset_profiles:
        if asset['asset_type'] != slot_schema['asset_type']:
            continue
        # basic semantic match (can be expanded)
        if any(tag in asset.get('semantic_tags', []) for tag in slot_schema.get('semantic_roles', [])):
            candidates.append(asset)
    return candidates