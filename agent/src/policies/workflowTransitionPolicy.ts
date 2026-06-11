import {
  executionPhaseAllows,
  isExecutionPhase,
} from './workflowDefinition.ts'

export interface WorkflowPhaseTransitionCheckInput {
  toolName: string
  fromPhase?: unknown
  toPhase?: unknown
  artifactTypes?: readonly string[]
}

export interface WorkflowPhaseTransitionCheck {
  allowed: boolean
  reason: string
}

const WORKFLOW_TOOL_PHASE_TRANSITIONS: Record<string, readonly string[]> = {
  get_invest_model_schema: ['discovering-data'],
  list_scene_data_cards: ['discovering-data'],
  discover_data_hub_candidates: ['awaiting-data-import-confirmation', 'discovering-data'],
  import_data_hub_files_to_scene: ['discovering-data'],
  finalize_data_matching: ['ready-for-validation', 'resolving-ambiguity'],
  validate_binding_report: ['awaiting-user-confirmation', 'validation-failed'],
  confirm_validation_snapshot: ['confirmed-for-execution', 'confirmation-rejected'],
  execute_validated_snapshot: ['job-running'],
  get_invest_job_status: ['job-running', 'job-succeeded', 'job-failed'],
  inspect_invest_job_outputs: ['outputs-inspected'],
  analyze_invest_results: ['results-analyzed'],
  interpret_invest_results: ['results-ready-for-interpretation'],
  write_invest_report: ['report-written'],
  finalize_sufficiency_assessment: ['sufficiency-assessed'],
}

const WORKFLOW_PHASE_REQUIRED_ARTIFACTS: Record<string, readonly string[]> = {
  'ready-for-validation': ['binding-report'],
  'awaiting-user-confirmation': ['validation-report'],
  'validation-failed': ['validation-report'],
  'confirmed-for-execution': ['confirmation-record'],
  'confirmation-rejected': ['confirmation-record'],
  'job-running': ['model-job'],
  'job-failed': ['job-status'],
  'job-succeeded': ['job-status'],
  'outputs-inspected': ['job-output-inventory'],
  'results-analyzed': ['result-analysis'],
  'results-ready-for-interpretation': ['result-interpretation-context'],
  'report-written': ['invest-report'],
  'sufficiency-assessed': ['sufficiency-report'],
}

const EXECUTION_PHASE_ORDER = [
  'confirmed-for-execution',
  'job-running',
  'job-failed',
  'job-succeeded',
  'outputs-inspected',
  'results-analyzed',
  'results-ready-for-interpretation',
  'report-written',
] as const

const EXECUTION_PHASE_RANK: ReadonlyMap<string, number> = new Map(
  EXECUTION_PHASE_ORDER.map((phase, index) => [phase, index]),
)

export function checkWorkflowPreExecution(
  input: Pick<WorkflowPhaseTransitionCheckInput, 'toolName' | 'fromPhase'>,
): WorkflowPhaseTransitionCheck {
  const phase = typeof input.fromPhase === 'string' ? input.fromPhase : ''
  if (!isExecutionPhase(phase)) {
    return { allowed: true, reason: 'matching-phase-allows-tool-entry' }
  }
  if (executionPhaseAllows(input.toolName, phase)) {
    return { allowed: true, reason: 'execution-phase-allows-tool' }
  }
  return {
    allowed: false,
    reason: `tool "${input.toolName}" cannot execute while workflow phase is "${phase}"`,
  }
}

export function checkWorkflowPhaseTransition(
  input: WorkflowPhaseTransitionCheckInput,
): WorkflowPhaseTransitionCheck {
  if (typeof input.toPhase !== 'string') {
    return { allowed: true, reason: 'no-phase-change' }
  }
  const fromPhase = typeof input.fromPhase === 'string' ? input.fromPhase : 'conversation-ready'
  const toPhase = input.toPhase
  const allowedTargets = WORKFLOW_TOOL_PHASE_TRANSITIONS[input.toolName]
  if (!allowedTargets) {
    return { allowed: true, reason: 'tool-has-no-state-machine-transition-policy' }
  }
  if (!allowedTargets.includes(toPhase)) {
    return {
      allowed: false,
      reason: `tool "${input.toolName}" cannot transition workflow phase to "${toPhase}"`,
    }
  }
  const artifactTypes = new Set(input.artifactTypes ?? [])
  const missingArtifacts = (WORKFLOW_PHASE_REQUIRED_ARTIFACTS[toPhase] ?? [])
    .filter(type => !artifactTypes.has(type))
  if (missingArtifacts.length) {
    return {
      allowed: false,
      reason: `phase "${toPhase}" requires artifact(s): ${missingArtifacts.join(', ')}`,
    }
  }
  if (isExecutionPhase(fromPhase) && !isExecutionPhase(toPhase)) {
    return {
      allowed: false,
      reason: `tool "${input.toolName}" cannot move workflow from execution phase "${fromPhase}" back to matching phase "${toPhase}"`,
    }
  }
  if (!isExecutionPhase(fromPhase) || !isExecutionPhase(toPhase) || fromPhase === toPhase) {
    return { allowed: true, reason: 'allowed-tool-target' }
  }
  const fromRank = EXECUTION_PHASE_RANK.get(fromPhase)
  const toRank = EXECUTION_PHASE_RANK.get(toPhase)
  if (fromRank === undefined || toRank === undefined || toRank >= fromRank) {
    return { allowed: true, reason: 'execution-phase-progresses' }
  }
  return {
    allowed: false,
    reason: `execution phase cannot move backward from "${fromPhase}" to "${toPhase}"`,
  }
}
