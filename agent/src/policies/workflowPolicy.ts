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
    phase: 'awaiting-data-import-confirmation',
    group: 'matching',
    persistAcrossRuns: true,
    resumeInstruction: 'A Data Hub import proposal exists. Call import_data_hub_files_to_scene with the proposed file IDs so the permission system can request user confirmation; do not finish with a plain-text confirmation question.',
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

export function phaseResumeInstruction(phase: string, modelId: string): string | undefined {
  return workflowPhasePolicy(phase)?.resumeInstruction?.replaceAll('{modelId}', modelId)
}

export interface WorkflowRunStartTransitionInput {
  phase?: unknown
  previousSceneId?: string
  currentSceneId?: string
}

export interface WorkflowRunStartTransition {
  shouldReset: boolean
  statePatch?: Record<string, unknown>
  staleArtifactTypes: readonly string[]
  reason: string
}

export function workflowRunStartTransition(
  input: WorkflowRunStartTransitionInput,
): WorkflowRunStartTransition {
  const phase = typeof input.phase === 'string' ? input.phase : ''
  const shouldReset =
    !WAITING_PHASES.has(phase) &&
    (!isExecutionPhase(phase) || !PERSISTED_EXECUTION_PHASES.has(phase))

  if (!shouldReset) {
    return {
      shouldReset: false,
      staleArtifactTypes: [],
      reason: 'phase-persists-across-run-start',
    }
  }

  const sceneChanged = Boolean(
    input.previousSceneId &&
    input.currentSceneId &&
    input.previousSceneId !== input.currentSceneId,
  )
  return {
    shouldReset: true,
    statePatch: sceneChanged
      ? { phase: 'discovering-data', matchingContextId: null, slots: null, bindingStatus: null }
      : { phase: 'discovering-data' },
    staleArtifactTypes: STALE_EXECUTION_ARTIFACT_TYPES,
    reason: sceneChanged ? 'scene-changed' : 'fresh-workflow-run',
  }
}

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

export interface WorkflowEvidenceInstructionInput {
  phase: string
  modelId: string
  counts: Readonly<Record<string, number | undefined>>
  missingRequiredSlots?: readonly string[]
  pendingImportFileIds?: readonly string[]
  dataAvailabilityInstruction?: string
}

export function workflowEvidenceInstruction(input: WorkflowEvidenceInstructionInput): string {
  const { phase, modelId, counts } = input
  if (phase === 'awaiting-data-import-confirmation') {
    const fileIds = input.pendingImportFileIds ?? []
    return fileIds.length
      ? `Call import_data_hub_files_to_scene with fileIds ${fileIds.join(', ')} for model "${modelId}" so the permission system can ask the user to confirm importing Data Hub references. Do not finish with a plain-text confirmation question.`
      : 'A Data Hub import proposal exists. Call import_data_hub_files_to_scene with the proposed file IDs so the permission system can request user confirmation; do not finish with a plain-text confirmation question.'
  }

  const phaseInstruction = phaseResumeInstruction(phase, modelId)
  if (phaseInstruction && (phase !== 'ready-for-validation' || counts['binding-report'])) {
    return phaseInstruction
  }

  if (phase === 'matching-slots' && counts['candidate-set']) {
    const missing = input.missingRequiredSlots ?? []
    if (missing.length) {
      return `Retrieve candidates for these required slots before finalizing: ${missing.join(', ')}. Prefer one call to retrieve_required_input_candidates for model "${modelId}" instead of parallel per-slot calls.`
    }
    return 'Reuse the persisted candidate sets and relation checks, then call finalize_data_matching. Do not construct a Binding Report manually.'
  }

  if (phase === 'sufficiency-assessed') {
    return 'Sufficiency assessment is complete. Call finish with the report findings.'
  }

  if (phase === 'validation-failed') {
    return 'Explain the persisted validation errors and stop unless the user changed bindings or parameters.'
  }

  if (phase === 'discovering-data' || phase === 'matching-slots') {
    if (input.dataAvailabilityInstruction) return input.dataAvailabilityInstruction

    const hasSchema = Boolean(counts['model-input-schema'])
    const hasDataCards = Boolean(counts['gsms-scene-data-cards'])
    const hasCandidates = Boolean(counts['candidate-set'])
    const hasSufficiencyReport = Boolean(counts['sufficiency-report'])
    const hasBindingReport = Boolean(counts['binding-report'])

    if (hasSufficiencyReport || hasBindingReport) {
      return 'Assessment or matching complete. Call finish with the findings.'
    }
    if (hasSchema && hasDataCards && hasCandidates) {
      return 'Schema, data cards, and candidates are loaded. If assessing sufficiency, call finalize_sufficiency_assessment. If matching, call finalize_data_matching.'
    }
    if (hasSchema && hasDataCards) {
      return `Schema and data cards loaded. Call retrieve_required_input_candidates once for model "${modelId}" to check all required slots. Do not invent *_asset_id slot names and do not call retrieve_input_candidates in parallel.`
    }
    if (hasDataCards) {
      return 'Data cards loaded. Call get_invest_model_schema for the target model, then retrieve_required_input_candidates once.'
    }
    if (hasSchema) {
      return 'Schema loaded. Call list_scene_data_cards to load scene data, then retrieve_required_input_candidates once.'
    }
    return 'Start by calling list_scene_data_cards and/or get_invest_model_schema to gather evidence.'
  }

  return 'If the user question is answered by available evidence, call finish. Otherwise continue gathering evidence.'
}
