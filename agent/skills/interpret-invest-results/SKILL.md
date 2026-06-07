---
name: interpret-invest-results
description: Monitor a GSMS InVEST job and prepare an evidence-backed interpretation of its outputs
allowed-tools:
  - get_invest_job_status
  - inspect_invest_job_outputs
  - interpret_invest_results
  - write_invest_report
user-invocable: true
model-invocable: true
execution: inline
---

Monitor and interpret the current InVEST model run without inventing results.

1. Refresh the exact current Job until it succeeds or fails.
2. If it fails, report the failure diagnostic and do not interpret outputs.
3. After success, inspect the structured output inventory.
4. Build an interpretation context from persisted outputs and execution logs.
5. Explain assumptions, validation warnings, missing outputs, and limitations.
6. Write the final evidence-backed Markdown report.

Do not infer ecological causality from model outputs alone. Distinguish model
estimates from observed environmental change.
