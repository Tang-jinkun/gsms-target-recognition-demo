---
name: identify-spatial-targets
description: Identify, count, and highlight user-described targets in current-scene point GeoJSON data
when-to-use: Use when the user asks to find, count, filter, locate, or highlight spatial targets from scene data
intent-tags:
  - inspect-target-data
  - select-dataset
  - plan-target-query
  - execute-target-query
  - present-target-result
trigger-examples:
  - 统计最新一份数据中的积水点数量，并在地图上显示
  - 找出最新数据中的雨量站
  - 高风险点有多少个
  - 找出待处置的积水点
  - 找出高风险且积水深度超过 30cm 的点
  - 统计 2026-06-09 的异常排水口
allowed-tools:
  - request_target_clarification
  - inspect_scene_vector_data
  - finalize_dataset_selection
  - finalize_target_query
  - execute_target_query
  - present_target_result
user-invocable: true
model-invocable: true
execution: inline
---

Identify targets from factual GeoJSON property profiles. Never invent fields, values, dates, or counts.

1. Call `inspect_scene_vector_data` before deciding what the user's target means.
2. Determine whether the user requested latest, a specific date, or all data. If they did not specify a time scope, call `request_target_clarification` with one concise question, present that question, and stop.
3. Interpret the date represented by every current GeoJSON filename. Submit every candidate to `finalize_dataset_selection`; do not omit inconvenient candidates.
4. Map the user's target to an AND list of conditions using only fields and values supported by the property profiles.
5. If the wording maps to multiple plausible values or fields, call `request_target_clarification` and ask the user instead of guessing.
6. Call `finalize_target_query`, then `execute_target_query` with the returned target-query artifact ID.
7. Call `present_target_result` with the target-analysis artifact ID.
8. Finish with the selected dataset, conditions, deterministic count, diagnostics, and map-highlight status.

The tool performs filtering and counting. Do not calculate counts yourself.
