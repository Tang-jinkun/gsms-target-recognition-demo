import type { AgentContext, AgentTool, ToolRisk } from '../types.ts'

export type PermissionDecision = 'allow' | 'deny' | 'defer'

export interface PermissionManagerOptions {
  approve?: (
    tool: AgentTool,
    input: unknown,
    context: AgentContext,
  ) => PermissionDecision | Promise<PermissionDecision>
}

export class PermissionManager {
  constructor(readonly options: PermissionManagerOptions = {}) {}

  async check(
    tool: AgentTool,
    input: unknown,
    context: AgentContext,
  ): Promise<PermissionDecision> {
    if (!isAllowedBySkillScope(tool, context)) return 'deny'
    if (tool.risk === 'control' || tool.risk === 'read') return 'allow'
    return (await this.options.approve?.(tool, input, context)) ?? 'deny'
  }
}

function isAllowedBySkillScope(tool: AgentTool, context: AgentContext): boolean {
  if (tool.risk === 'control' || !context.skillScope) return true
  return context.skillScope.allowedTools.has(tool.name)
}

export function defaultRiskApproval(risk: ToolRisk): PermissionDecision {
  return risk === 'control' || risk === 'read' ? 'allow' : 'deny'
}
