import type { AgentContext, AgentTool, Artifact } from '@gsms/agent-core'
import { modelInputSchemaSchema } from './domain/schemas.ts'

export type WorkflowBoundary =
  | 'matching'
  | 'validation'
  | 'confirmation'
  | 'execution'
  | 'interpretation'

const boundaryTools: Record<WorkflowBoundary, Set<string>> = {
  matching: new Set([
    'list_invest_models',
    'get_invest_model_schema',
    'list_scene_data_cards',
    'retrieve_input_candidates',
    'check_data_relation',
    'finalize_data_matching',
  ]),
  validation: new Set(['validate_binding_report']),
  confirmation: new Set(['confirm_validation_snapshot']),
  execution: new Set(['execute_validated_snapshot', 'get_invest_job_status']),
  interpretation: new Set([
    'get_invest_job_status',
    'inspect_invest_job_outputs',
    'analyze_invest_results',
    'interpret_invest_results',
    'write_invest_report',
  ]),
}

const boundaryOrder: WorkflowBoundary[] = [
  'matching',
  'validation',
  'confirmation',
  'execution',
  'interpretation',
]

export function inferWorkflowBoundary(request: string): WorkflowBoundary {
  const text = request.toLowerCase()
  if (/(解释|解读|报告|interpret|report|结果)/.test(text)) return 'interpretation'
  if (/(准备执行|请求.*确认|request.*confirmation|prepare.*execut)/.test(text)) return 'confirmation'
  if (/(执行|运行|run|execute)/.test(text) && !/(不要执行|不要运行|do not execute|don't execute|do not run)/.test(text)) {
    return 'execution'
  }
  if (/(确认|批准|approve|confirm)/.test(text)) return 'confirmation'
  if (/(验证|validate|validation)/.test(text)) return 'validation'
  return 'matching'
}

export function workflowToolFilter(boundary: WorkflowBoundary) {
  const allowed = new Set<string>(['skill', 'finish', 'update_goal'])
  for (const item of boundaryOrder.slice(0, boundaryOrder.indexOf(boundary) + 1)) {
    for (const tool of boundaryTools[item]) allowed.add(tool)
  }
  return (tool: AgentTool, context: AgentContext): boolean =>
    allowed.has(tool.name) && phaseAllows(tool.name, context)
}

function phaseAllows(toolName: string, context: AgentContext): boolean {
  if (['skill', 'finish', 'update_goal', 'list_invest_models'].includes(toolName)) return true
  const state = context.domainState.snapshot()
  const artifacts = context.artifacts.list()
  const matchingContextId =
    typeof state.matchingContextId === 'string' ? state.matchingContextId : undefined
  const current = (type: string) =>
    artifacts.filter(artifact =>
      artifact.type === type &&
      (!matchingContextId || artifact.metadata?.matchingContextId === matchingContextId))

  if (state.phase === 'job-running') return toolName === 'get_invest_job_status'
  if (state.phase === 'job-succeeded') return toolName === 'inspect_invest_job_outputs'
  if (state.phase === 'outputs-inspected') return toolName === 'analyze_invest_results'
  if (state.phase === 'results-analyzed') return toolName === 'interpret_invest_results'
  if (state.phase === 'results-ready-for-interpretation') return toolName === 'write_invest_report'
  if (state.phase === 'report-written') return false

  if (toolName === 'get_invest_model_schema') return !matchingContextId || !current('binding-report').length
  if (!hasCurrentSchema(state.modelId, artifacts)) return false
  if (!matchingContextId) return toolName === 'list_scene_data_cards'

  const schema = currentSchema(state.modelId, artifacts)
  const candidateSlots = new Set(current('candidate-set').map(artifact => artifact.metadata?.slot))
  const missingRequired = schema?.slots
    .filter(slot => slot.required && !candidateSlots.has(slot.name))
    .map(slot => slot.name) ?? []
  if (missingRequired.length) return toolName === 'retrieve_input_candidates'

  if (!current('binding-report').length) {
    return ['retrieve_input_candidates', 'check_data_relation', 'finalize_data_matching'].includes(toolName)
  }
  if (state.phase === 'ready-for-validation') return toolName === 'validate_binding_report'
  if (state.phase === 'awaiting-user-confirmation') return toolName === 'confirm_validation_snapshot'
  if (state.phase === 'confirmed-for-execution') return toolName === 'execute_validated_snapshot'
  return true
}

function hasCurrentSchema(modelId: unknown, artifacts: Artifact[]): boolean {
  return Boolean(currentSchema(modelId, artifacts))
}

function currentSchema(modelId: unknown, artifacts: Artifact[]) {
  const artifact = [...artifacts]
    .reverse()
    .find(item => item.type === 'model-input-schema' && (!modelId || item.metadata?.modelId === modelId))
  return artifact ? modelInputSchemaSchema.parse(artifact.data) : undefined
}
