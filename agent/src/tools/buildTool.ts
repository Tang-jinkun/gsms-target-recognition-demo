import type { AgentTool, AgentToolResult, AgentContext, ToolProgressEvent } from '@gsms/agent-core'

export interface ToolConfig {
  name: string
  description: string
  risk?: AgentTool['risk']
  inputSchema: Record<string, unknown>
  persistResultAboveBytes?: number
  policy?: AgentTool['policy']
  execute(input: unknown, context: AgentContext, onProgress?: (event: ToolProgressEvent) => void): Promise<AgentToolResult>
}

/**
 * Factory for building AgentTool instances with sensible defaults.
 * Reduces boilerplate and centralizes cross-cutting concerns (e.g., persistResultAboveBytes).
 */
export function buildTool(config: ToolConfig): AgentTool {
  return {
    name: config.name,
    description: config.description,
    risk: config.risk ?? 'read',
    inputSchema: config.inputSchema,
    persistResultAboveBytes: config.persistResultAboveBytes,
    policy: config.policy,
    execute: config.execute,
  }
}
