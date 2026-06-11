import {
  ToolRegistry,
  type AgentContext,
  type AgentTool,
  type AgentToolResult,
  type ToolProgressEvent,
} from '@gsms/agent-core'
import { checkWorkflowPhaseTransition } from './policies/workflowPolicy.ts'

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
      const result = await tool.execute(input, context, onProgress)
      const check = checkWorkflowPhaseTransition({
        toolName: tool.name,
        fromPhase,
        toPhase: result.statePatch?.phase,
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
