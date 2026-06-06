# Reask Messages Template

This file contains template messages that the agent can use to ask the user for clarification or missing data during data matching.

## Missing Required Input

- Carbon Pools CSV missing:
  "I could not find a valid Carbon pools CSV. Please upload a CSV containing lucode, c_above, c_below, c_soil, and c_dead columns."

## Ambiguous LULC Candidates

- Two or more LULC rasters with similar confidence scores:
  "I found two possible LULC rasters: {{asset_1}} and {{asset_2}}. Which one should be used as the baseline LULC input for the Carbon model?"

## Relation Check Not Verified

- LULC values could not be sampled:
  "The LULC raster values could not be sampled, so the Carbon table relation check could not be performed. Please confirm if the top candidates are correct."

## Relation Check Failed

- Carbon table missing LULC coverage:
  "The Carbon pools CSV does not contain entries for LULC codes: {{missing_codes}}. Please update or replace the CSV."