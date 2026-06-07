import {
  AgentRuntime,
  ArtifactStore,
  DomainStateStore,
  PermissionManager,
  ToolRegistry,
  createSkillAgentTool,
  finishTool,
  updateGoalTool,
  type AgentRunResult,
  type AgentTool,
  type ModelAdapter,
  type PermissionDecision,
} from '@gsms/agent-core'
import { SkillRegistry, SkillTool } from '@gsms/skills-core'
import { inferWorkflowBoundary, workflowToolFilter } from '../workflowBoundary.ts'

export interface InvestAgentSessionOptions {
  model: ModelAdapter
  tools: ToolRegistry
  skills: SkillRegistry
  workspace: string
  sceneId: string
  maxTurns: number
  approve: (
    tool: AgentTool,
    input: unknown,
    context: Parameters<PermissionManager['check']>[2],
  ) => PermissionDecision | Promise<PermissionDecision>
  onSkillInvocation?: (message: string) => void
}

export class InvestAgentSession {
  readonly artifacts = new ArtifactStore()
  readonly domainState: DomainStateStore
  readonly #history: Array<{ user: string; summary: string }> = []

  constructor(readonly options: InvestAgentSessionOptions) {
    this.domainState = new DomainStateStore({ sceneId: options.sceneId, phase: 'conversation-ready' })
  }

  async send(message: string): Promise<AgentRunResult> {
    const workflowBoundary = inferWorkflowBoundary(message)
    this.domainState.applyPatch(
      workflowBoundary === 'matching'
        ? {
            workflowBoundary,
            phase: 'discovering-data',
            matchingContextId: null,
            slots: null,
            bindingStatus: null,
          }
        : { workflowBoundary },
    )
    const objective = [
      `Current GSMS scene ID: ${this.options.sceneId}`,
      this.#history.length
        ? `Previous conversation summaries:\n${this.#history
            .slice(-6)
            .map(item => `- User: ${item.user}\n  Agent: ${item.summary}`)
            .join('\n')}`
        : '',
      `Current user request:\n${message}`,
      `Current workflow boundary: ${workflowBoundary}. Do not act beyond this boundary.`,
      'The current user request overrides earlier planning state. If it names or implies a different InVEST model, select that model again before matching or validation.',
      'Act on the current request using the persisted artifacts and domain state from this session.',
    ]
      .filter(Boolean)
      .join('\n\n')
    const runtime = new AgentRuntime({
      model: this.options.model,
      tools: this.options.tools,
      skills: this.options.skills,
      workspace: this.options.workspace,
      permissions: new PermissionManager({ approve: this.options.approve }),
      artifacts: this.artifacts,
      domainState: this.domainState,
      maxTurns: this.options.maxTurns,
      toolFilter: workflowToolFilter(workflowBoundary),
    })
    const result = await runtime.run(objective)
    this.#history.push({
      user: message,
      summary:
        result.goal.finalSummary ??
        result.goal.progress ??
        `${result.goal.status}; phase=${String(result.domainState.phase ?? 'unknown')}`,
    })
    return result
  }

  status(): Record<string, unknown> {
    return {
      sceneId: this.options.sceneId,
      domainState: this.domainState.snapshot(),
      artifactCount: this.artifacts.list().length,
      turns: this.#history.length,
    }
  }
}

export function registerSessionControlTools(
  registry: ToolRegistry,
  skills: SkillRegistry,
  availableTools: () => readonly string[],
  onSkillInvocation?: (message: string) => void,
): void {
  registry.register(updateGoalTool)
  registry.register(finishTool)
  registry.register(
    createSkillAgentTool(new SkillTool(skills), {
      availableTools,
      authorizeProjectSkill: async () => true,
      onInvocation: record => onSkillInvocation?.(`${record.skill}: ${record.outcome}`),
    }),
  )
}
