---
name: interpret-invest-results
description: Monitor a GSMS InVEST job and prepare an evidence-backed interpretation of its outputs
allowed-tools:
  - get_invest_job_status
  - inspect_invest_job_outputs
  - analyze_invest_results
  - interpret_invest_results
  - write_invest_report
user-invocable: true
model-invocable: true
execution: inline
---

Monitor and interpret the current InVEST model run without inventing results.

1. Refresh the exact current Job with `get_invest_job_status` until it succeeds or fails.
2. If it fails, report the failure diagnostic and do not interpret outputs.
3. After success, inspect the structured output inventory once with `inspect_invest_job_outputs`.
4. Call `analyze_invest_results` to request deterministic raster statistics from the backend.
   The backend reads real GeoTIFF pixel values; do not attempt to read or download outputs yourself.
5. Call `interpret_invest_results` to build the interpretation context. This tool reads the
   execution log internally; do not call or invent separate log, file, workspace, or read tools.
6. Explain assumptions, validation warnings, missing outputs, and limitations.
7. Write the final evidence-backed Markdown report.

Do not infer ecological causality from model outputs alone. Distinguish model
estimates from observed environmental change.
All numerical values in the report must come from the result-analysis artifact.
Do not claim to have analyzed individual carbon pools; the current Carbon outputs
represent total carbon storage.
Use only the tools listed in this Skill. If a stage is already persisted, continue
from that stage without repeating earlier tools.
