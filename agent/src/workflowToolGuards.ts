import {
  ToolRegistry,
  type AgentContext,
  type AgentTool,
  type AgentToolResult,
  type ToolProgressEvent,
} from '@gsms/agent-core'
import { checkWorkflowPhaseTransition, checkWorkflowPreExecution } from './policies/workflowPolicy.ts'

export function workflowToolRegistry(registry: ToolRegistry): ToolRegistry {
  return new ToolRegistry(registry.list().map(enforceWorkflowPhaseTransitions))
}

export function enforceWorkflowPhaseTransitions(tool: AgentTool): AgentTool {
  return {
    ...tool,
    async execute(
      input: unknown,
      context: AgentContext,
      onProgress?: (event: ToolProgressEvent) => void,
    ): Promise<AgentToolResult> {
      const fromPhase = context.domainState.snapshot().phase
      const preCheck = checkWorkflowPreExecution({
        toolName: tool.name,
        fromPhase,
      })
      if (!preCheck.allowed) {
        throw new Error(JSON.stringify({
          code: 'WORKFLOW_PRE_EXECUTION_BLOCKED',
          message: preCheck.reason,
          tool: tool.name,
          fromPhase,
        }))
      }
      const result = await tool.execute(input, context, onProgress)
      const artifactTypes = [
        ...context.artifacts.list().map(artifact => artifact.type),
        ...(result.artifacts ?? []).map(artifact => artifact.type),
      ]
      const check = checkWorkflowPhaseTransition({
        toolName: tool.name,
        fromPhase,
        toPhase: result.statePatch?.phase,
        artifactTypes,
      })
      if (!check.allowed) {
        throw new Error(JSON.stringify({
          code: 'INVALID_WORKFLOW_PHASE_TRANSITION',
          message: check.reason,
          tool: tool.name,
          fromPhase,
          toPhase: result.statePatch?.phase,
        }))
      }
      return result
    },
  }
}
