# Data Matching Skill Examples

These examples show how an agent should use the Data Matching Skill in the current MVP scope: InVEST Carbon Storage and Sequestration.

---

## Example 1: Successful Carbon matching

### Context

Available assets:

```text
asset_lulc_001: landuse_2020.tif
asset_carbon_001: carbon_pools.csv
```

### Agent trace

```text
1. Confirm model_id = invest_carbon.
2. Load the Carbon Model Input Schema.
3. Load project asset profiles.
4. Identify required asset-bound slots: lulc_bas_path and carbon_pools_path.
5. Retrieve raster candidates for lulc_bas_path.
6. Rank landuse_2020.tif highest.
7. Retrieve CSV candidates for carbon_pools_path.
8. Rank carbon_pools.csv highest.
9. Check carbon_lucode_coverage.
10. Build Binding Report.
11. Proceed to validation.
```

### Expected report fragment

```json
{
  "project_id": "default",
  "model_id": "invest_carbon",
  "status": "auto_bound",
  "overall_confidence": 0.91,
  "bindings": {
    "lulc_bas_path": {
      "asset_id": "asset_lulc_001",
      "decision": "selected",
      "score": 0.90,
      "evidence": [
        "asset_type matches raster",
        "filename contains landuse",
        "band_count is 1",
        "crs is present"
      ],
      "warnings": []
    },
    "carbon_pools_path": {
      "asset_id": "asset_carbon_001",
      "decision": "selected",
      "score": 0.95,
      "evidence": [
        "asset_type matches table",
        "required Carbon columns are present",
        "filename contains carbon"
      ],
      "warnings": []
    }
  },
  "relations": [
    {
      "relation_id": "carbon_lucode_coverage",
      "status": "passed",
      "evidence": ["carbon table lucode covers sampled LULC values"]
    }
  ],
  "conflicts": [],
  "recommended_next_action": "proceed_to_validation"
}
```

---

## Example 2: Missing Carbon pools table

### Context

Available assets:

```text
asset_lulc_001: landuse_2020.tif
asset_dem_001: dem.tif
```

No CSV contains the required Carbon pool columns.

### Agent trace

```text
1. Confirm model_id = invest_carbon.
2. Load the Carbon Model Input Schema.
3. Find a plausible LULC raster.
4. Search for carbon_pools_path candidates.
5. Find no CSV table with lucode, c_above, c_below, c_soil, c_dead.
6. Mark carbon_pools_path as missing_required_input.
7. Stop auto-binding.
8. Ask the user to upload a Carbon pools CSV.
```

### Expected report fragment

```json
{
  "project_id": "default",
  "model_id": "invest_carbon",
  "status": "failed",
  "bindings": {
    "lulc_bas_path": {
      "asset_id": "asset_lulc_001",
      "decision": "selected",
      "score": 0.90
    }
  },
  "missing_required_inputs": [
    {
      "slot": "carbon_pools_path",
      "expected": "CSV with lucode, c_above, c_below, c_soil, c_dead columns"
    }
  ],
  "conflicts": [
    {
      "type": "missing_required_input",
      "slot": "carbon_pools_path",
      "message": "No valid Carbon pools CSV was found."
    }
  ],
  "recommended_next_action": "ask_user_to_upload_data"
}
```

### Recommended user-facing message

```text
I found a likely LULC raster, but I could not find a valid Carbon pools CSV. Please upload a CSV containing lucode, c_above, c_below, c_soil, and c_dead columns.
```

---

## Example 3: Ambiguous LULC candidates

### Context

Available assets:

```text
asset_lulc_2020: landuse_2020.tif
asset_lulc_2023: landuse_2023.tif
asset_carbon_001: carbon_pools.csv
```

The user did not specify a year.

### Expected report fragment

```json
{
  "status": "needs_review",
  "ambiguous_inputs": [
    {
      "slot": "lulc_bas_path",
      "candidates": [
        {"asset_id": "asset_lulc_2020", "score": 0.88},
        {"asset_id": "asset_lulc_2023", "score": 0.86}
      ],
      "reason": "Two LULC candidates have similar scores and no task year was specified."
    }
  ],
  "recommended_next_action": "ask_user_to_confirm"
}
```

### Recommended user-facing message

```text
I found two possible LULC rasters: landuse_2020.tif and landuse_2023.tif. Which one should be used as the baseline LULC input for the Carbon model?
```

---

## Example 4: Relation check not verified

### Context

The agent identifies both LULC and Carbon table candidates, but raster unique values cannot be sampled.

### Expected report fragment

```json
{
  "status": "needs_review",
  "relations": [
    {
      "relation_id": "carbon_lucode_coverage",
      "status": "not_checked",
      "evidence": ["LULC unique values could not be sampled."],
      "warnings": ["Could not verify whether carbon table lucode covers LULC classes."]
    }
  ],
  "recommended_next_action": "ask_user_to_confirm"
}
```

---

## Example 5: Relation check failed

### Context

Sampled LULC values:

```text
1, 2, 3, 4, 5, 6
```

Carbon table `lucode` values:

```text
1, 2, 3, 4
```

Missing codes:

```text
5, 6
```

### Expected report fragment

```json
{
  "status": "failed",
  "relations": [
    {
      "relation_id": "carbon_lucode_coverage",
      "status": "failed",
      "evidence": [
        "Sampled LULC values include codes that are not present in carbon_pools_path.lucode."
      ],
      "details": {
        "missing_codes": [5, 6]
      }
    }
  ],
  "conflicts": [
    {
      "type": "relation_failure",
      "slot": "carbon_pools_path",
      "message": "Carbon pools table does not cover all sampled LULC class codes."
    }
  ],
  "recommended_next_action": "ask_user_to_upload_data"
}
```

### Recommended user-facing message

```text
The Carbon pools CSV does not contain carbon values for LULC codes 5 and 6. Please update the CSV so that every LULC class code has a corresponding lucode row.
```
