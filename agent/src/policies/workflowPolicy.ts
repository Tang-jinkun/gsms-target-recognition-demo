export type PhaseGroup = 'matching' | 'execution'

export interface WorkflowPhasePolicy {
  phase: string
  group: PhaseGroup
  allowedTool?: string
  resumeInstruction?: string
  persistAcrossRuns?: boolean
}

export const WORKFLOW_PHASE_POLICIES: readonly WorkflowPhasePolicy[] = [
  {
    phase: 'ready-for-validation',
    group: 'matching',
    persistAcrossRuns: true,
    resumeInstruction: 'A {modelId} Binding Report already exists. Call validate_binding_report directly; do not reload schemas, retrieve candidates, or submit another report.',
  },
  {
    phase: 'awaiting-user-confirmation',
    group: 'matching',
    persistAcrossRuns: true,
    resumeInstruction: 'Validation already passed. Call confirm_validation_snapshot once to request explicit user confirmation; do not validate again.',
  },
  {
    phase: 'validation-failed',
    group: 'matching',
    persistAcrossRuns: true,
    resumeInstruction: 'Explain the persisted validation errors and stop unless the user changed bindings or parameters.',
  },
  {
    phase: 'confirmation-rejected',
    group: 'matching',
    persistAcrossRuns: true,
  },
  {
    phase: 'confirmed-for-execution',
    group: 'execution',
    allowedTool: 'execute_validated_snapshot',
    resumeInstruction: 'The validation snapshot is confirmed for execution. Call execute_validated_snapshot immediately to start the InVEST model run. Do not load skills, inspect outputs, or call any other tool.',
  },
  {
    phase: 'job-running',
    group: 'execution',
    allowedTool: 'get_invest_job_status',
    resumeInstruction: 'Refresh the current job with get_invest_job_status. Do not invent alternate status or output tools.',
  },
  {
    phase: 'job-failed',
    group: 'execution',
    allowedTool: 'get_invest_job_status',
  },
  {
    phase: 'job-succeeded',
    group: 'execution',
    allowedTool: 'inspect_invest_job_outputs',
    resumeInstruction: 'The current job succeeded. Call inspect_invest_job_outputs once; do not invent output or workspace tools.',
  },
  {
    phase: 'outputs-inspected',
    group: 'execution',
    allowedTool: 'analyze_invest_results',
    resumeInstruction: 'The current output inventory is persisted. Call analyze_invest_results directly to request deterministic raster statistics. Do not inspect outputs again or invent log/read tools.',
  },
  {
    phase: 'results-analyzed',
    group: 'execution',
    allowedTool: 'interpret_invest_results',
    resumeInstruction: 'The result analysis is persisted. Call interpret_invest_results directly; it reads the execution log internally. Do not inspect outputs again, do not analyze results again, and do not invent log/read tools.',
  },
  {
    phase: 'results-ready-for-interpretation',
    group: 'execution',
    allowedTool: 'write_invest_report',
    resumeInstruction: 'The output inventory and interpretation context are persisted. Call write_invest_report directly; do not inspect outputs, read logs, or rebuild interpretation.',
  },
  {
    phase: 'report-written',
    group: 'execution',
    allowedTool: 'get_invest_job_status',
    resumeInstruction: 'A previous report exists. If the current user asks for real result analysis or a new report, call get_invest_job_status and rebuild the interpretation chain from deterministic outputs; otherwise finish with the persisted report path.',
  },
]

export const ALWAYS_ALLOWED_WORKFLOW_TOOLS = new Set([
  'skill',
  'finish',
  'update_goal',
  'list_invest_models',
])

export const BLOCKED_WHILE_AMBIGUOUS = new Set([
  'validate_binding_report',
  'confirm_validation_snapshot',
  'finalize_sufficiency_assessment',
])

export const WAITING_PHASES = new Set(
  WORKFLOW_PHASE_POLICIES
    .filter(policy => policy.persistAcrossRuns)
    .map(policy => policy.phase),
)

const WORKFLOW_PHASE_POLICY_BY_PHASE = new Map(
  WORKFLOW_PHASE_POLICIES.map(policy => [policy.phase, policy]),
)

export function workflowPhasePolicy(phase: string): WorkflowPhasePolicy | undefined {
  return WORKFLOW_PHASE_POLICY_BY_PHASE.get(phase)
}

export function getPhaseGroup(phase: string): PhaseGroup {
  return workflowPhasePolicy(phase)?.group ?? 'matching'
}

export function isExecutionPhase(phase: string): boolean {
  return getPhaseGroup(phase) === 'execution'
}

export function executionPhaseAllows(toolName: string, phase: string): boolean {
  if (ALWAYS_ALLOWED_WORKFLOW_TOOLS.has(toolName)) return true
  return workflowPhasePolicy(phase)?.allowedTool === toolName
}

export function phaseResumeInstruction(phase: string, modelId: string): string | undefined {
  return workflowPhasePolicy(phase)?.resumeInstruction?.replaceAll('{modelId}', modelId)
}
