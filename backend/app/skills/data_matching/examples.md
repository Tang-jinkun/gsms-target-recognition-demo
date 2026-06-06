# Data Matching Skill Examples

This file provides example usage scenarios for the Data Matching Skill to guide agents.

## Example 1: Successful Carbon Matching

**Input:**
- Model: invest_carbon
- Task Spec: baseline carbon storage
- Project assets: LULC raster and Carbon pool CSV available

**Agent Workflow:**
1. Load model input schema
2. Load project asset profiles
3. Retrieve candidates for `lulc_bas_path`
4. Match LULC candidates
5. Retrieve candidates for `carbon_pools_path`
6. Match Carbon table candidates
7. Check LULC vs Carbon table relation (lucode coverage)
8. Score candidates
9. Detect conflicts (none found)
10. Build Binding Report

**Output:**
- Binding Report indicates auto-bind for both slots
- Confidence scores high (>= 0.85)
- No conflicts or missing inputs
- Recommended next action: proceed to validation

## Example 2: Missing Carbon Table

**Input:**
- Model: invest_carbon
- Task Spec: baseline carbon storage
- Project assets: LULC raster available, Carbon pool CSV missing

**Agent Workflow:**
1. Load model input schema
2. Load project asset profiles
3. Retrieve candidates for `lulc_bas_path`
4. Match LULC candidates
5. Retrieve candidates for `carbon_pools_path` (none found)
6. Detect missing required input for `carbon_pools_path`
7. Agent does not auto-bind
8. Recommended next action: ask user to upload CSV

## Example 3: Ambiguous LULC Candidates

**Input:**
- Model: invest_carbon
- Task Spec: baseline carbon storage
- Project assets: two LULC raster candidates for `lulc_bas_path` with similar scores

**Agent Workflow:**
1. Retrieve candidates
2. Match slot and compute preliminary scores
3. Detect ambiguous candidates
4. Build Binding Report marking `lulc_bas_path` as needs_review
5. Recommended next action: ask user to confirm which LULC to use