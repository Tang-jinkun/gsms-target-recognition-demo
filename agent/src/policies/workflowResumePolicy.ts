const PHASE_RESUME_INSTRUCTIONS: Readonly<Record<string, string>> = {
  'ready-for-validation': 'A {modelId} Binding Report already exists. Call validate_binding_report directly; do not reload schemas, retrieve candidates, or submit another report.',
  'awaiting-user-confirmation': 'Validation already passed. Call confirm_validation_snapshot once to request explicit user confirmation; do not validate again.',
  'validation-failed': 'Explain the persisted validation errors and stop unless the user changed bindings or parameters.',
  'awaiting-data-import-confirmation': 'A Data Hub import proposal exists. Call import_data_hub_files_to_scene with the proposed file IDs so the permission system can request user confirmation; do not finish with a plain-text confirmation question.',
  'confirmed-for-execution': 'The validation snapshot is confirmed for execution. Call execute_validated_snapshot immediately to start the InVEST model run. Do not load skills, inspect outputs, or call any other tool.',
  'job-running': 'Refresh the current job with get_invest_job_status. Do not invent alternate status or output tools.',
  'job-succeeded': 'The current job succeeded. Call inspect_invest_job_outputs once; do not invent output or workspace tools.',
  'outputs-inspected': 'The current output inventory is persisted. Call analyze_invest_results directly to request deterministic raster statistics. Do not inspect outputs again or invent log/read tools.',
  'results-analyzed': 'The result analysis is persisted. Call interpret_invest_results directly; it reads the execution log internally. Do not inspect outputs again, do not analyze results again, and do not invent log/read tools.',
  'results-ready-for-interpretation': 'The output inventory and interpretation context are persisted. Call write_invest_report directly; do not inspect outputs, read logs, or rebuild interpretation.',
  'report-written': 'A previous report exists. If the current user asks for real result analysis or a new report, call get_invest_job_status and rebuild the interpretation chain from deterministic outputs; otherwise finish with the persisted report path.',
}

export function phaseResumeInstruction(phase: string, modelId: string): string | undefined {
  return PHASE_RESUME_INSTRUCTIONS[phase]?.replaceAll('{modelId}', modelId)
}
