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

// ── Matching Phase Gate (evidence-gated) ───────────────────────────────────────
// The model chooses tool order, but visibility narrows based on what evidence
// has been produced. This prevents "answer without doing work" while preserving
// freedom of exploration path.

function matchingPhaseAllows(toolName: string, context: AgentContext): boolean {
  // Always-visible tools in matching group
  if (['list_invest_models', 'get_invest_model_schema', 'list_scene_data_cards'].includes(toolName)) {
    return true
  }

  const artifacts = context.artifacts.list()
  const hasSchema = artifacts.some(a => a.type === 'model-input-schema')
  const hasDataCards = artifacts.some(a => a.type === 'gsms-scene-data-cards')
  const hasCandidates = artifacts.some(a => a.type === 'candidate-set')
  const hasBindingReport = artifacts.some(a => a.type === 'binding-report')

  // retrieve_input_candidates: needs schema + data cards
  if (toolName === 'retrieve_input_candidates') return hasSchema && hasDataCards

  // check_data_relation: needs schema + data cards
  if (toolName === 'check_data_relation') return hasSchema && hasDataCards

  // finalize_sufficiency_assessment: needs schema + data cards + candidates
  if (toolName === 'finalize_sufficiency_assessment') return hasSchema && hasDataCards && hasCandidates

  // finalize_data_matching: needs schema + data cards + candidates
  if (toolName === 'finalize_data_matching') return hasSchema && hasDataCards && hasCandidates

  // validate_binding_report: needs binding report
  if (toolName === 'validate_binding_report') return hasBindingReport

  // confirm_validation_snapshot: needs validation report
  if (toolName === 'confirm_validation_snapshot') {
    return artifacts.some(a => a.type === 'validation-report')
  }

  // execute_validated_snapshot: needs confirmation record
  if (toolName === 'execute_validated_snapshot') {
    return artifacts.some(a => a.type === 'confirmation-record')
  }

  return true
}

// ── Finish Evidence Gate ───────────────────────────────────────────────────────
// finish is only visible when the current intent's minimum evidence exists.
// This is the core mechanism that prevents "answer without doing work".

function finishPassesEvidenceGate(context: AgentContext): boolean {
  const artifacts = context.artifacts.list()
  const domainArtifacts = artifacts.filter(a =>
    !['goal-progress'].includes(a.type)
  )
  // Minimum: at least one domain artifact must exist
  if (domainArtifacts.length === 0) return false

  // If sufficiency-report or binding-report exists, finish is allowed
  if (domainArtifacts.some(a =>
    a.type === 'sufficiency-report' ||
    a.type === 'binding-report' ||
    a.type === 'invest-report'
  )) return true

  // If we have data cards + schema, finish is allowed (exploration complete)
  const hasSchema = domainArtifacts.some(a => a.type === 'model-input-schema')
  const hasDataCards = domainArtifacts.some(a => a.type === 'gsms-scene-data-cards')
  if (hasSchema && hasDataCards) return true

  // If we only have model list, finish is allowed (basic exploration)
  if (domainArtifacts.some(a => a.type === 'gsms-model-list')) return true

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
