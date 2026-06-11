import type { AgentContext, AgentTool, Artifact, DomainState } from '@gsms/agent-core'
import { evaluateDataAvailabilityPolicy } from './policies/dataAvailabilityPolicy.ts'

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

export type PhaseGroup = 'matching' | 'execution'

// Execution pipeline: each entry defines which tool is allowed at that phase.
// The pipeline is traversed in order; any phase not listed here is 'matching'.
// Tools in the `alwaysAllowed` set are permitted at every execution phase.
const EXECUTION_PIPELINE: Array<{ phase: string; allowedTool: string }> = [
  { phase: 'confirmed-for-execution', allowedTool: 'execute_validated_snapshot' },
  { phase: 'job-running',             allowedTool: 'get_invest_job_status' },
  { phase: 'job-failed',              allowedTool: 'get_invest_job_status' },
  { phase: 'job-succeeded',           allowedTool: 'inspect_invest_job_outputs' },
  { phase: 'outputs-inspected',       allowedTool: 'analyze_invest_results' },
  { phase: 'results-analyzed',        allowedTool: 'interpret_invest_results' },
  { phase: 'results-ready-for-interpretation', allowedTool: 'write_invest_report' },
  { phase: 'report-written',          allowedTool: 'get_invest_job_status' },
]

const EXECUTION_PHASES = new Set(EXECUTION_PIPELINE.map(e => e.phase))
const EXECUTION_ALLOWED_TOOLS = new Map(EXECUTION_PIPELINE.map(e => [e.phase, e.allowedTool]))

// Always allowed in both matching and execution groups
const ALWAYS_ALLOWED = new Set(['skill', 'finish', 'update_goal', 'list_invest_models'])

// While a finalized binding has an unresolved ambiguity (needs_review), these
// forward/branch tools are hidden — the only way forward is a user decision +
// re-finalize. Hiding them stops the agent from looping validate/confirm or
// wandering into the off-path sufficiency survey.
const BLOCKED_WHILE_AMBIGUOUS = new Set([
  'validate_binding_report',
  'confirm_validation_snapshot',
  'finalize_sufficiency_assessment',
])

// Matching phases that must persist across runs (user interaction in progress).
// Used by InvestAgentSession and InvestAgentWorker to avoid resetting active workflows.
export const WAITING_PHASES = new Set([
  'awaiting-user-confirmation',
  'validation-failed',
  'confirmation-rejected',
  'ready-for-validation',
])

export function getPhaseGroup(phase: string): PhaseGroup {
  return EXECUTION_PHASES.has(phase) ? 'execution' : 'matching'
}

export function isExecutionPhase(phase: string): boolean {
  return getPhaseGroup(phase) === 'execution'
}

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

interface EvidenceRequirement {
  artifactTypes: string[]
  description: string
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

// ── Phase Filter ───────────────────────────────────────────────────────────────

export function workflowPhaseFilter(tools: readonly AgentTool[] = []) {
  return (tool: AgentTool, context: AgentContext): boolean => {
    if (['skill', 'update_goal'].includes(tool.name)) return true

    if (!allDomainTools.has(tool.name) && tool.name !== 'finish') return true

    const state = context.domainState.snapshot()
    const phase = typeof state.phase === 'string' ? state.phase : ''
    const group = getPhaseGroup(phase)

    // ── Hard gate: execution group ──────────────────────────────────────────
    if (group === 'execution') {
      return executionPhaseAllows(tool.name, phase)
    }

    // ── Soft boundary: matching group ───────────────────────────────────────
    // finish has its own evidence gate — only enforced in matching group
    if (tool.name === 'finish') return finishPassesEvidenceGate(context, tools)

    return matchingPhaseAllows(tool.name, state, context)
  }
}

// ── Execution Phase Gate (hard) ────────────────────────────────────────────────

function executionPhaseAllows(toolName: string, phase: string): boolean {
  if (ALWAYS_ALLOWED.has(toolName)) return true
  return EXECUTION_ALLOWED_TOOLS.get(phase) === toolName
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
): boolean {
  const artifacts = context.artifacts.list()
  const state = context.domainState.snapshot()
  const matchingContextId =
    typeof state.matchingContextId === 'string' ? state.matchingContextId : undefined

  const domainArtifacts = artifacts.filter(a => !['goal-progress'].includes(a.type))
  // No domain artifacts = the agent explored but didn't produce GSMS-specific
  // evidence (e.g. generic file operations).  Allow finish freely — blocking
  // would force the agent into an unproductive loop.
  if (domainArtifacts.length === 0) return true

  // Current-context artifacts (matching scope)
  const currentArtifacts = matchingContextId
    ? domainArtifacts.filter(a => !a.metadata?.matchingContextId || a.metadata.matchingContextId === matchingContextId)
    : domainArtifacts

  const has = (type: string) => currentArtifacts.some(a => a.type === type)
  const hasSceneImportRecord = has('scene-import-record')
  const hasRefreshedSceneData = hasRefreshedArtifact(currentArtifacts, 'gsms-scene-data-cards')
  const unsatisfiedMutationRefresh = findUnsatisfiedMutationRefresh(currentArtifacts, tools)
  const dataAvailability = evaluateDataAvailabilityPolicy(state, currentArtifacts)

  // Single-model sufficiency on an empty scene must probe Data Hub before the
  // agent can finish. A gsms-scene-data-cards artifact with data_cards: [] is
  // evidence that the current scene is empty, not evidence that there is no
  // usable data anywhere in the project.
  if (dataAvailability.requiresExternalDiscovery) return false

  // Importing Data Hub files changes the scene data universe. The agent must
  // refresh scene facts and continue from those facts before it can finish.
  if (unsatisfiedMutationRefresh) return false

  // Backward-compatible guard for older persisted Data Hub import records that
  // predate the generic mutation policy metadata.
  if (hasSceneImportRecord && !hasRefreshedSceneData && !has('candidate-set') && !has('sufficiency-report') && !has('binding-report')) {
    return false
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
