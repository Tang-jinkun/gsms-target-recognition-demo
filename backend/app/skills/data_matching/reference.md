# Data Matching Skill Reference

This file provides detailed background information, terminology, and schema guidance for the Data Matching Skill.

## 1. Purpose

The reference document supplements SKILL.md by providing deeper explanations of the data matching workflow, input and output structures, Carbon model input schema, Data Cards, and Binding Report structure.

## 2. Terminology

- **Slot**: A required or optional input parameter of a geospatial model.
- **Candidate**: A project asset that could be used to satisfy a slot.
- **Data Card / Asset Profile**: Structured metadata describing a project asset, including type, semantic tags, and relevant metadata.
- **Binding Report**: Structured JSON report summarizing which candidates are assigned to which slots, with confidence scores, evidence, conflicts, and next actions.
- **Relation Rule**: Constraints across multiple slots, e.g., LULC raster unique values must be covered by carbon table lucode.

## 3. Carbon Model Input Schema (MVP)

### Required Slots

```yaml
lulc_bas_path:
  type: raster
  semantic_roles: [lulc, landuse, landcover]
  constraints:
    single_band_preferred: true
    crs_present: true
    categorical_integer_preferred: true

carbon_pools_path:
  type: table
  semantic_roles: [carbon_pool_table]
  required_columns: [lucode, c_above, c_below, c_soil, c_dead]
```

### Optional / System-Generated Slots

```yaml
workspace_dir: system_generated
results_suffix: system_generated
calc_sequestration: default false
n_workers: default -1
```

### Relations

```yaml
- id: carbon_lucode_coverage
  type: table_column_should_cover_raster_values
  raster_slot: lulc_bas_path
  table_slot: carbon_pools_path
  table_column: lucode
  severity: warning_for_mvp
```

## 4. Data Card / Asset Profile Schema

- **Raster Asset**:
  - asset_id
  - filename
  - asset_type: raster
  - path
  - semantic_tags
  - metadata: crs, bounds, width, height, band_count, nodata, dtype

- **Table Asset**:
  - asset_id
  - filename
  - asset_type: table
  - path
  - semantic_tags
  - metadata: columns, row_count, sample_rows

## 5. Evidence and Confidence

- Slot evaluation produces evidence list per candidate.
- Confidence score calculated from type match, semantic match, schema match, metadata completeness, content profile.
- Conflicts include missing_required_input, ambiguous_candidates, hard_constraint_failure, relation_failure, metadata_incomplete, unsupported_asset_type.

## 6. Recommended Next Actions

- proceed_to_validation
- ask_user_to_confirm
- ask_user_to_upload_data
- retry_with_relaxed_filters
- stop_and_explain