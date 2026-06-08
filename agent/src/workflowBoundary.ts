import type { AgentContext, AgentTool } from '@gsms/agent-core'

// ── Phase Group ────────────────────────────────────────────────────────────────
// Phases are divided into two groups:
//
//   'matching'  – planning / discovery / validation / confirmation.
//                 The user may freely roll back to earlier phases in this group.
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

// ── Tool Sets ──────────────────────────────────────────────────────────────────

const matchingTools = new Set([
  'list_invest_models',
  'get_invest_model_schema',
  'list_scene_data_cards',
  'retrieve_input_candidates',
  'check_data_relation',
  'finalize_data_matching',
])

const validationTools = new Set([
  'validate_binding_report',
])

const confirmationTools = new Set([
  'confirm_validation_snapshot',
])

const executionTools = new Set([
  'execute_validated_snapshot',
  'get_invest_job_status',
])

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
// Returns a toolFilter function for AgentRuntime.
//
// • Execution-group phases (hard gate): only the one correct next tool is allowed.
//   This preserves scientific computation integrity — you cannot skip or reorder
//   phases whose ordering is dictated by real data dependencies.
//
// • Matching-group phases (soft boundary): all tools from the matching group
//   are available, plus tools from later groups if the agent decides to advance.
//   This allows the user to roll back, revise, and re-advance freely.

export function workflowPhaseFilter() {
  return (tool: AgentTool, context: AgentContext): boolean => {
    if (['skill', 'finish', 'update_goal'].includes(tool.name)) return true
    if (!allDomainTools.has(tool.name)) return true

    const state = context.domainState.snapshot()
    const phase = typeof state.phase === 'string' ? state.phase : ''
    const group = getPhaseGroup(phase)

    // ── Hard gate: execution group ──────────────────────────────────────────
    if (group === 'execution') {
      return executionPhaseAllows(tool.name, phase)
    }

    // ── Soft boundary: matching group ───────────────────────────────────────
    return matchingPhaseAllows()
  }
}

// ── Execution Phase Gate (hard) ────────────────────────────────────────────────
// Each execution phase permits exactly one forward tool. No rollback.

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

// ── Matching Phase Gate (soft) ─────────────────────────────────────────────────
// All domain tools are visible during matching-group phases.
// The agent decides call order based on the user's request.
// Tools internally enforce their own prerequisites (defense-in-depth):
//   - finalize_data_matching throws if candidate sets are missing
//   - validate_binding_report throws if no binding report exists
//   - etc.

function matchingPhaseAllows(): boolean {
  return true
}

// ── Helpers ────────────────────────────────────────────────────────────────────
// (artifact/schema helpers removed — matching group no longer needs them)
