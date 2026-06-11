export type PhaseGroup = 'matching' | 'execution'

export interface WorkflowPhasePolicy {
  phase: string
  group: PhaseGroup
  allowedTool?: string
  persistAcrossRuns?: boolean
}

export const WORKFLOW_PHASE_POLICIES: readonly WorkflowPhasePolicy[] = [
  {
    phase: 'ready-for-validation',
    group: 'matching',
    persistAcrossRuns: true,
  },
  {
    phase: 'awaiting-user-confirmation',
    group: 'matching',
    persistAcrossRuns: true,
  },
  {
    phase: 'validation-failed',
    group: 'matching',
    persistAcrossRuns: true,
  },
  {
    phase: 'confirmation-rejected',
    group: 'matching',
    persistAcrossRuns: true,
  },
  {
    phase: 'awaiting-data-import-confirmation',
    group: 'matching',
    persistAcrossRuns: true,
  },
  {
    phase: 'confirmed-for-execution',
    group: 'execution',
    allowedTool: 'execute_validated_snapshot',
  },
  {
    phase: 'job-running',
    group: 'execution',
    allowedTool: 'get_invest_job_status',
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
  },
  {
    phase: 'outputs-inspected',
    group: 'execution',
    allowedTool: 'analyze_invest_results',
  },
  {
    phase: 'results-analyzed',
    group: 'execution',
    allowedTool: 'interpret_invest_results',
  },
  {
    phase: 'results-ready-for-interpretation',
    group: 'execution',
    allowedTool: 'write_invest_report',
  },
  {
    phase: 'report-written',
    group: 'execution',
    allowedTool: 'get_invest_job_status',
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

export const PERSISTED_EXECUTION_PHASES = new Set([
  'job-running',
  'confirmed-for-execution',
  'results-ready-for-interpretation',
  'report-written',
])

export const STALE_EXECUTION_ARTIFACT_TYPES = [
  'model-job',
  'job-status',
  'validation-report',
  'confirmation-record',
  'job-output-inventory',
  'result-analysis',
  'result-interpretation-context',
  'invest-report',
  'raster-statistics',
  'job-execution-log',
  'output-inventory',
] as const

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
