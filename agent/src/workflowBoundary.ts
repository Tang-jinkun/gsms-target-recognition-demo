import type { AgentContext, AgentTool, Artifact, DomainState } from '@gsms/agent-core'
import type { WorkflowAction } from './intent/TurnIntentRouter.ts'
import { evaluateDataAvailabilityPolicy } from './policies/dataAvailabilityPolicy.ts'
import {
  BLOCKED_WHILE_AMBIGUOUS,
  executionPhaseAllows,
  getPhaseGroup,
  isExecutionPhase,
  STALE_EXECUTION_ARTIFACT_TYPES,
  WAITING_PHASES,
  type PhaseGroup,
} from './policies/workflowPolicy.ts'

// ── Phase Group ────────────────────────────────────────────────────────────────
// Phases are divided into two groups:
//
//   'matching'  – planning / discovery / validation / confirmation.
//                 The user may freely roll back to earlier phases in this group.
//                 Tool visibility is controlled by Evidence Gate, not hard sequence.
//
//   'execution' – job execution through report writing.
//                 Phases progress in strict order dictated by real computation outputs.
//                 No rollback to the matching group is possible once execution starts.

export { getPhaseGroup, isExecutionPhase, WAITING_PHASES, type PhaseGroup }

// ── Workflow Intent ────────────────────────────────────────────────────────────
// What the user is trying to do. Inferred from artifacts + message, not just keywords.

export type WorkflowIntent =
  | 'explore-data'         // "场景有什么数据？能跑哪些模型？"
  | 'assess-sufficiency'   // "Carbon 模型数据够不够？"
  | 'match-inputs'         // "帮我匹配数据"
  | 'validate-and-execute' // "验证并运行"

// ── Evidence Gate ──────────────────────────────────────────────────────────────
// Each intent has a minimum set of artifacts that must exist before the agent
// can finish or advance. The model chooses the order, but must produce evidence.

export interface EvidenceRequirement {
  artifactTypes: string[]
  description: string
}

export type WorkflowStage =
  | 'explore'
  | 'match'
  | 'validate'
  | 'confirm'
  | 'execute'
  | 'inspect-results'
  | 'write-report'

export interface TurnBoundary {
  action: WorkflowAction
  allowedStages: WorkflowStage[]
  forbiddenCapabilities: string[]
  evidenceRequirements: EvidenceRequirement[]
}

const EVIDENCE_GATES: Record<WorkflowIntent, EvidenceRequirement> = {
  'explore-data': {
    artifactTypes: ['gsms-scene-data-cards'],
    description: 'Scene data cards must be loaded',
  },
  'assess-sufficiency': {
    artifactTypes: ['model-input-schema', 'candidate-set'],
    description: 'Model schema and candidate sets for required slots',
  },
  'match-inputs': {
    artifactTypes: ['model-input-schema', 'candidate-set', 'binding-report'],
    description: 'Full binding report with all required slots matched',
  },
  'validate-and-execute': {
    artifactTypes: ['binding-report', 'validation-report'],
    description: 'Validated execution plan',
  },
}

// ── Tool Sets ──────────────────────────────────────────────────────────────────

const matchingTools = new Set([
  'list_invest_models',
  'get_invest_model_schema',
  'list_scene_data_cards',
  'discover_data_hub_candidates',
  'import_data_hub_files_to_scene',
  'retrieve_input_candidates',
  'retrieve_required_input_candidates',
  'check_data_relation',
  'finalize_data_matching',
  'finalize_sufficiency_assessment',
  'assess_scene_model_readiness',
  'run_reconnaissance',
  'record_user_disambiguation',
])

const validationTools = new Set(['validate_binding_report'])
const confirmationTools = new Set(['confirm_validation_snapshot'])
const executionTools = new Set(['execute_validated_snapshot', 'get_invest_job_status'])
const interpretationTools = new Set([
  'get_invest_job_status',
  'inspect_invest_job_outputs',
  'analyze_invest_results',
  'interpret_invest_results',
  'write_invest_report',
])

const allDomainTools = new Set([
  ...matchingTools,
  ...validationTools,
  ...confirmationTools,
  ...executionTools,
  ...interpretationTools,
])

const turnStageTools: Record<WorkflowStage, ReadonlySet<string>> = {
  explore: new Set([
    'list_invest_models',
    'get_invest_model_schema',
    'list_scene_data_cards',
    'discover_data_hub_candidates',
    'import_data_hub_files_to_scene',
    'assess_scene_model_readiness',
    'finalize_sufficiency_assessment',
  ]),
  match: matchingTools,
  validate: new Set([...matchingTools, ...validationTools]),
  confirm: new Set([...validationTools, ...confirmationTools]),
  execute: new Set(['execute_validated_snapshot', 'get_invest_job_status']),
  'inspect-results': new Set([
    'get_invest_job_status',
    'inspect_invest_job_outputs',
    'analyze_invest_results',
    'interpret_invest_results',
  ]),
  'write-report': interpretationTools,
}

const TURN_BOUNDARY_BY_ACTION: Record<WorkflowAction, TurnBoundary> = {
  'assess-runnable-models': {
    action: 'assess-runnable-models',
    allowedStages: ['explore'],
    forbiddenCapabilities: ['validate', 'confirm', 'execute', 'write-report'],
    evidenceRequirements: [{
      artifactTypes: ['scene-model-readiness'],
      description: 'Scene/model readiness assessment for the current scene',
    }],
  },
  'match-inputs': {
    action: 'match-inputs',
    allowedStages: ['explore', 'match'],
    forbiddenCapabilities: ['validate', 'confirm', 'execute', 'write-report'],
    evidenceRequirements: [{
      artifactTypes: ['binding-report'],
      description: 'Binding report for the current model inputs',
    }],
  },
  validate: {
    action: 'validate',
    allowedStages: ['explore', 'match', 'validate'],
    forbiddenCapabilities: ['confirm', 'execute', 'write-report'],
    evidenceRequirements: [{
      artifactTypes: ['validation-report'],
      description: 'Authoritative validation report for the current binding report',
    }],
  },
  confirm: {
    action: 'confirm',
    allowedStages: ['confirm'],
    forbiddenCapabilities: ['execute', 'write-report'],
    evidenceRequirements: [{
      artifactTypes: ['confirmation-record'],
      description: 'User confirmation record bound to the validated snapshot',
    }],
  },
  execute: {
    action: 'execute',
    allowedStages: ['execute'],
    forbiddenCapabilities: [],
    evidenceRequirements: [{
      artifactTypes: ['model-job'],
      description: 'GSMS model job created from a confirmed validation snapshot',
    }],
  },
  'inspect-results': {
    action: 'inspect-results',
    allowedStages: ['inspect-results'],
    forbiddenCapabilities: ['match', 'validate', 'confirm', 'execute'],
    evidenceRequirements: [{
      artifactTypes: ['job-output-inventory'],
      description: 'Output inventory for the completed model job',
    }],
  },
  'write-report': {
    action: 'write-report',
    allowedStages: ['inspect-results', 'write-report'],
    forbiddenCapabilities: ['match', 'validate', 'confirm', 'execute'],
    evidenceRequirements: [{
      artifactTypes: ['invest-report'],
      description: 'Evidence-backed InVEST report',
    }],
  },
}

export function buildTurnBoundary(action: WorkflowAction | undefined): TurnBoundary | undefined {
  return action ? TURN_BOUNDARY_BY_ACTION[action] : undefined
}

export interface TurnBoundaryStateTransition {
  statePatch?: Record<string, unknown>
  staleArtifactTypes: readonly string[]
}

export function workflowTurnBoundaryTransition(
  boundary: TurnBoundary | undefined,
  state: Record<string, unknown>,
): TurnBoundaryStateTransition {
  const phase = typeof state.phase === 'string' ? state.phase : ''
  if (!boundary || !isExecutionPhase(phase) || !turnBoundaryAllowsMatchingRollback(boundary)) {
    return { staleArtifactTypes: [] }
  }

  if (boundary.action === 'confirm') {
    return {
      statePatch: {
        phase: 'awaiting-user-confirmation',
        confirmationStatus: null,
        jobId: null,
      },
      staleArtifactTypes: STALE_EXECUTION_ARTIFACT_TYPES.filter(type =>
        type !== 'validation-report',
      ),
    }
  }

  const phaseByAction: Partial<Record<WorkflowAction, string>> = {
    'assess-runnable-models': 'discovering-data',
    'match-inputs': 'matching-slots',
    validate: 'ready-for-validation',
  }
  const nextPhase = phaseByAction[boundary.action]
  if (!nextPhase) return { staleArtifactTypes: [] }

  return {
    statePatch: {
      phase: nextPhase,
      validationStatus: null,
      validationSnapshotId: null,
      confirmationStatus: null,
      jobId: null,
    },
    staleArtifactTypes: STALE_EXECUTION_ARTIFACT_TYPES,
  }
}

// ── Phase Filter ───────────────────────────────────────────────────────────────

export function workflowPhaseFilter(
  tools: readonly AgentTool[] = [],
  turnBoundary?: TurnBoundary,
) {
  return (tool: AgentTool, context: AgentContext): boolean => {
    if (['skill', 'update_goal'].includes(tool.name)) return true

    if (!allDomainTools.has(tool.name) && tool.name !== 'finish') return true

    if (turnBoundary && tool.name !== 'finish' && !turnBoundaryAllowsTool(turnBoundary, tool.name)) {
      return false
    }

    const state = context.domainState.snapshot()
    const phase = typeof state.phase === 'string' ? state.phase : ''
    const group = getPhaseGroup(phase)

    // ── Hard gate: execution group ──────────────────────────────────────────
    if (group === 'execution' && !turnBoundaryAllowsMatchingRollback(turnBoundary)) {
      return executionPhaseAllows(tool.name, phase)
    }

    // ── Soft boundary: matching group ───────────────────────────────────────
    // finish has its own evidence gate — only enforced in matching group
    if (tool.name === 'finish') return finishPassesEvidenceGate(context, tools, turnBoundary)

    return matchingPhaseAllows(tool.name, state, context)
  }
}

export function turnBoundaryAllowsTool(boundary: TurnBoundary, toolName: string): boolean {
  return boundary.allowedStages.some(stage => turnStageTools[stage].has(toolName))
}

function turnBoundaryAllowsMatchingRollback(boundary: TurnBoundary | undefined): boolean {
  return Boolean(boundary?.allowedStages.some(stage =>
    stage === 'explore' || stage === 'match' || stage === 'validate' || stage === 'confirm',
  ))
}

// ── Matching Phase Gate (tool-visibility) ──────────────────────────────────────
// Domain tools are visible in the matching group so the model chooses its own
// investigation path; gates inside tools (DataMatchingGate, etc.) enforce evidence
// quality. The one exception: while a finalized binding is blocked on an
// unresolved ambiguity (needs_review), forward/branch tools are hidden so the
// agent must get a user decision and re-finalize instead of looping.
//
// This is the correct separation:
//   - Workflow Boundary: controls which phase group the agent is in (matching vs execution)
//   - Tools: enforce their own prerequisites via internal gates
//   - Skills: teach the model how to investigate
//   - finish: gated by finishPassesEvidenceGate (needs at least one domain artifact)

function matchingPhaseAllows(toolName: string, state: DomainState, context: AgentContext): boolean {
  const ambiguityUnresolved =
    state.bindingStatus === 'needs_review' || state.phase === 'resolving-ambiguity'
  if (ambiguityUnresolved && BLOCKED_WHILE_AMBIGUOUS.has(toolName)) return false
  if (
    toolName === 'import_data_hub_files_to_scene' &&
    context.artifacts.list().some(hasImportableProposal)
  ) {
    return true
  }
  const dataAvailability = evaluateDataAvailabilityPolicy(state, context.artifacts.list())
  if (dataAvailability.requiresExternalDiscovery) {
    return dataAvailability.allowedTools.has(toolName)
  }
  return true
}

// ── Finish Evidence Gate ───────────────────────────────────────────────────────
// finish is only visible when sufficient evidence exists for the work attempted.
// The gate is intent-aware: if the agent started matching (has candidates), it
// must complete the binding report. If it only explored, lighter evidence suffices.
//
// Evidence is filtered by current matchingContextId where applicable — stale
// evidence from a previous scene/model combination cannot satisfy the gate.

function finishPassesEvidenceGate(
  context: AgentContext,
  tools: readonly AgentTool[] = [],
  turnBoundary?: TurnBoundary,
): boolean {
  const artifacts = context.artifacts.list()
  const state = context.domainState.snapshot()
  const matchingContextId =
    typeof state.matchingContextId === 'string' ? state.matchingContextId : undefined

  const domainArtifacts = artifacts.filter(a => !['goal-progress'].includes(a.type))

  // Current-context artifacts (matching scope)
  const currentArtifacts = matchingContextId
    ? domainArtifacts.filter(a => !a.metadata?.matchingContextId || a.metadata.matchingContextId === matchingContextId)
    : domainArtifacts

  const has = (type: string) => currentArtifacts.some(a => a.type === type)
  const hasSceneImportRecord = has('scene-import-record')
  const hasRefreshedSceneData = hasRefreshedArtifact(currentArtifacts, 'gsms-scene-data-cards')
  const hasPendingImportProposal = currentArtifacts.some(hasImportableProposal)
  const unsatisfiedMutationRefresh = findUnsatisfiedMutationRefresh(currentArtifacts, tools)
  const dataAvailability = evaluateDataAvailabilityPolicy(state, currentArtifacts)

  // No domain artifacts = the agent explored but didn't produce GSMS-specific
  // evidence (e.g. generic file operations).  Allow finish freely only when
  // this turn did not declare a workflow-specific evidence contract.
  if (domainArtifacts.length === 0 && !turnBoundary) return true

  // Single-model sufficiency on an empty scene must probe Data Hub before the
  // agent can finish. A gsms-scene-data-cards artifact with data_cards: [] is
  // evidence that the current scene is empty, not evidence that there is no
  // usable data anywhere in the project.
  if (dataAvailability.requiresExternalDiscovery) return false

  // Once discovery found importable Data Hub candidates, the workflow must
  // enter the protected import tool so the UI can request confirmation. A plain
  // text "please confirm" answer cannot satisfy this phase.
  if (state.phase === 'awaiting-data-import-confirmation' && hasPendingImportProposal) {
    return false
  }

  // Importing Data Hub files changes the scene data universe. The agent must
  // refresh scene facts and continue from those facts before it can finish.
  if (unsatisfiedMutationRefresh) return false

  // Backward-compatible guard for older persisted Data Hub import records that
  // predate the generic mutation policy metadata.
  if (hasSceneImportRecord && !hasRefreshedSceneData && !has('candidate-set') && !has('sufficiency-report') && !has('binding-report')) {
    return false
  }

  if (turnBoundary?.evidenceRequirements.length) {
    return turnBoundary.evidenceRequirements.every(requirement =>
      requirement.artifactTypes.every(type => has(type)),
    )
  }

  // Terminal evidence: always allows finish
  if (has('sufficiency-report') || has('binding-report') || has('invest-report') || has('scene-model-readiness')) return true

  // If the agent started matching (has candidate-sets), it MUST complete the
  // binding report. Cannot finish with just candidates — that's an incomplete workflow.
  if (has('candidate-set')) return false

  // If schema + data-cards exist, finish is allowed (exploration/assessment complete)
  if (has('model-input-schema') && has('gsms-scene-data-cards')) return true

  // Model list only: basic exploration
  if (has('gsms-model-list')) return true

  // Data cards only (no schema): basic scene exploration
  if (has('gsms-scene-data-cards')) return true

  // Fallback: if the agent produced any domain artifacts that aren't
  // candidate-sets (blocked above), allow finish.  This covers custom
  // artifact types like scene-fact, model-skill, or any domain evidence
  // the agent gathered without going through the full GSMS matching pipeline.
  if (currentArtifacts.length > 0) return true

  return false
}

function findUnsatisfiedMutationRefresh(
  artifacts: readonly Artifact[],
  tools: readonly AgentTool[],
): { tool: string; missingArtifactTypes: string[] } | undefined {
  const toolsByName = new Map(tools.map(tool => [tool.name, tool]))
  const mutationRecords = artifacts.filter(artifact =>
    artifact.type === 'scene-import-record' ||
    artifact.metadata?.mutationTool ||
    artifact.metadata?.tool,
  )
  for (const record of mutationRecords) {
    const toolName =
      typeof record.metadata?.mutationTool === 'string'
        ? record.metadata.mutationTool
        : typeof record.metadata?.tool === 'string'
          ? record.metadata.tool
          : record.type === 'scene-import-record'
            ? 'import_data_hub_files_to_scene'
            : undefined
    if (!toolName) continue
    const refreshesArtifacts = toolsByName.get(toolName)?.policy?.mutation?.refreshesArtifacts ?? []
    if (!refreshesArtifacts.length) continue
    const missingArtifactTypes = refreshesArtifacts.filter(type => !hasRefreshedArtifact(artifacts, type))
    if (missingArtifactTypes.length) return { tool: toolName, missingArtifactTypes }
  }
  return undefined
}

function hasRefreshedArtifact(
  artifacts: readonly Artifact[],
  type: string,
): boolean {
  return artifacts.some(artifact =>
    artifact.type === type &&
    (artifact.metadata?.refreshedAfterMutation === true || artifact.metadata?.refreshedAfterImport === true),
  )
}

function hasImportableProposal(artifact: Artifact): boolean {
  if (artifact.type !== 'confirmation-proposal' && artifact.type !== 'data-hub-import-proposal') {
    return false
  }
  if (artifact.metadata?.actionTool && artifact.metadata.actionTool !== 'import_data_hub_files_to_scene') {
    return false
  }
  const proposedFileIds = artifact.metadata?.proposedFileIds
  return Array.isArray(proposedFileIds) && proposedFileIds.length > 0
}

// ── Intent Inference ───────────────────────────────────────────────────────────
// Infers workflow intent from existing artifacts + user message.
// Used by skills and directives, not by the tool filter (which uses evidence gates directly).

export function inferIntent(artifacts: Artifact[], request: string): WorkflowIntent {
  const text = request.toLowerCase()
  const has = (type: string) => artifacts.some(a => a.type === type)

  // If binding report exists, user is at match-inputs or beyond
  if (has('binding-report')) {
    if (/(验证|执行|运行|validate|execute|run)/.test(text)) return 'validate-and-execute'
    return 'match-inputs'
  }

  // If candidate sets exist, user is at assess-sufficiency or match-inputs
  if (has('candidate-set')) {
    if (/(匹配|绑定|match|bind)/.test(text)) return 'match-inputs'
    return 'assess-sufficiency'
  }

  // If schema exists, user is at assess-sufficiency
  if (has('model-input-schema')) {
    if (/(足够|是否|sufficien|enough|can.*run)/.test(text)) return 'assess-sufficiency'
    return 'explore-data'
  }

  return 'explore-data'
}
