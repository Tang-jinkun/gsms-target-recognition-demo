import type { AgentContext, AgentTool, Artifact, DomainState } from '@gsms/agent-core'

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

const phaseGroupMap: Record<string, PhaseGroup> = {
  // matching group — soft boundary, rollback allowed
  'conversation-ready': 'matching',
  'discovering-data': 'matching',
  'matching-slots': 'matching',
  'resolving-ambiguity': 'matching',
  'ready-for-validation': 'matching',
  'awaiting-user-confirmation': 'matching',
  'validation-failed': 'matching',
  'confirmation-rejected': 'matching',
  'sufficiency-assessed': 'matching',
  // execution group — hard gate, strict sequential order
  'confirmed-for-execution': 'execution',
  'job-running': 'execution',
  'job-failed': 'execution',
  'job-succeeded': 'execution',
  'outputs-inspected': 'execution',
  'results-analyzed': 'execution',
  'results-ready-for-interpretation': 'execution',
  'report-written': 'execution',
}

export function getPhaseGroup(phase: string): PhaseGroup {
  return phaseGroupMap[phase] ?? 'matching'
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
  'retrieve_input_candidates',
  'check_data_relation',
  'finalize_data_matching',
  'finalize_sufficiency_assessment',
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

export function workflowPhaseFilter() {
  return (tool: AgentTool, context: AgentContext): boolean => {
    if (['skill', 'update_goal'].includes(tool.name)) return true
    if (!allDomainTools.has(tool.name)) return true

    const state = context.domainState.snapshot()
    const phase = typeof state.phase === 'string' ? state.phase : ''
    const group = getPhaseGroup(phase)

    // ── Hard gate: execution group ──────────────────────────────────────────
    if (group === 'execution') {
      return executionPhaseAllows(tool.name, phase)
    }

    // ── Soft boundary: matching group with evidence gate ────────────────────
    // finish has its own evidence gate
    if (tool.name === 'finish') return finishPassesEvidenceGate(context)
    return matchingPhaseAllows(tool.name, context)
  }
}

// ── Execution Phase Gate (hard) ────────────────────────────────────────────────

function executionPhaseAllows(toolName: string, phase: string): boolean {
  if (['skill', 'finish', 'update_goal', 'list_invest_models'].includes(toolName)) return true

  if (phase === 'job-running') return toolName === 'get_invest_job_status'
  if (phase === 'job-succeeded') return toolName === 'inspect_invest_job_outputs'
  if (phase === 'outputs-inspected') return toolName === 'analyze_invest_results'
  if (phase === 'results-analyzed') return toolName === 'interpret_invest_results'
  if (phase === 'results-ready-for-interpretation') return toolName === 'write_invest_report'
  if (phase === 'report-written') return toolName === 'get_invest_job_status'
  if (phase === 'confirmed-for-execution') return toolName === 'execute_validated_snapshot'
  if (phase === 'job-failed') return toolName === 'get_invest_job_status'

  return true
}

// ── Matching Phase Gate (tool-visibility) ──────────────────────────────────────
// All domain tools are visible in the matching group. The model chooses its own
// investigation path. Gates inside tools (DataMatchingGate, etc.) enforce evidence
// quality — the boundary layer does not encode a fixed tool sequence.
//
// This is the correct separation:
//   - Workflow Boundary: controls which phase group the agent is in (matching vs execution)
//   - Tools: enforce their own prerequisites via internal gates
//   - Skills: teach the model how to investigate
//   - finish: gated by finishPassesEvidenceGate (needs at least one domain artifact)

function matchingPhaseAllows(): boolean {
  return true
}

// ── Finish Evidence Gate ───────────────────────────────────────────────────────
// finish is only visible when sufficient evidence exists for the work attempted.
// The gate is intent-aware: if the agent started matching (has candidates), it
// must complete the binding report. If it only explored, lighter evidence suffices.
//
// Evidence is filtered by current matchingContextId where applicable — stale
// evidence from a previous scene/model combination cannot satisfy the gate.

function finishPassesEvidenceGate(context: AgentContext): boolean {
  const artifacts = context.artifacts.list()
  const state = context.domainState.snapshot()
  const matchingContextId =
    typeof state.matchingContextId === 'string' ? state.matchingContextId : undefined

  const domainArtifacts = artifacts.filter(a => !['goal-progress'].includes(a.type))
  if (domainArtifacts.length === 0) return false

  // Current-context artifacts (matching scope)
  const currentArtifacts = matchingContextId
    ? domainArtifacts.filter(a => !a.metadata?.matchingContextId || a.metadata.matchingContextId === matchingContextId)
    : domainArtifacts

  const has = (type: string) => currentArtifacts.some(a => a.type === type)

  // Terminal evidence: always allows finish
  if (has('sufficiency-report') || has('binding-report') || has('invest-report')) return true

  // If the agent started matching (has candidate-sets), it MUST complete the
  // binding report. Cannot finish with just candidates — that's an incomplete workflow.
  if (has('candidate-set')) return false

  // If schema + data-cards exist, finish is allowed (exploration/assessment complete)
  if (has('model-input-schema') && has('gsms-scene-data-cards')) return true

  // Model list only: basic exploration
  if (has('gsms-model-list')) return true

  // Data cards only (no schema): basic scene exploration
  if (has('gsms-scene-data-cards')) return true

  return false
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
