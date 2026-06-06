"""
Primitive helper for scoring candidate assets against a model input slot.
"""

def match_slot(slot_schema, candidates, task_spec):
    """Evaluate candidates and return ranked list with evidence and preliminary scores."""
    ranked = []
    for asset in candidates:
        score = 0.0
        evidence = []
        warnings = []
        # Type match
        if asset['asset_type'] == slot_schema['asset_type']:
            score += 0.25
            evidence.append(f"asset_type matches {slot_schema['asset_type']}")
        else:
            warnings.append(f"asset_type mismatch: {asset['asset_type']}")
        # Semantic tag match
        if any(tag in asset.get('semantic_tags', []) for tag in slot_schema.get('semantic_roles', [])):
            score += 0.25
            evidence.append("semantic_tags match slot roles")
        # Additional checks: metadata, band_count, columns
        metadata = asset.get('metadata', {})
        if slot_schema['asset_type'] == 'raster':
            if metadata.get('band_count', 1) == 1:
                score += 0.2
                evidence.append("band_count is 1")
            if metadata.get('crs'):
                score += 0.15
                evidence.append("CRS is present")
        elif slot_schema['asset_type'] == 'table':
            required_cols = slot_schema.get('required_columns', [])
            if all(col in metadata.get('columns', []) for col in required_cols):
                score += 0.3
                evidence.append("all required columns present")
        ranked.append({
            'asset_id': asset['asset_id'],
            'score': score,
            'evidence': evidence,
            'warnings': warnings
        })
    # Sort descending by score
    ranked.sort(key=lambda x: x['score'], reverse=True)
    return ranked