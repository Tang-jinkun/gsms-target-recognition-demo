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
import { TurnIntentRouter, summarizeTurnPlan, type TurnPlan } from '../intent/TurnIntentRouter.ts'
import { workflowRunStartTransition } from '../policies/workflowPolicy.ts'
import { buildTurnBoundary, workflowPhaseFilter, workflowTurnBoundaryTransition } from '../workflowBoundary.ts'
import { workflowToolRegistry } from '../workflowToolGuards.ts'

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
  intentClassifierModel?: ModelAdapter
  onSkillInvocation?: (message: string) => void
}

export class InvestAgentSession {
  readonly artifacts = new ArtifactStore()
  readonly domainState: DomainStateStore
  readonly #history: Array<{ user: string; summary: string }> = []
  readonly #controlTools = new ToolRegistry([updateGoalTool, finishTool])

  constructor(readonly options: InvestAgentSessionOptions) {
    this.domainState = new DomainStateStore({ sceneId: options.sceneId, phase: 'conversation-ready' })
  }

  async send(message: string): Promise<AgentRunResult> {
    const plan = await new TurnIntentRouter({
      classifierModel: this.options.intentClassifierModel,
    }).route({
      userMessage: message,
      domainState: this.domainState.snapshot(),
      artifacts: this.artifacts.list(undefined, { includeSuperseded: true }),
      skillSummaries: this.options.skills.listForModel(),
    })
    if (plan.intent === 'ambiguous') {
      return this.#runPlainTurn(
        message,
        plan,
        plan.promptContext.clarificationQuestion ?? 'Ask one concise clarifying question. Do not assume the user wants an InVEST workflow.',
      )
    }
    if (plan.intent === 'general-answer') {
      return this.#runPlainTurn(
        message,
        plan,
        'Answer directly. Do not use GSMS scene context, InVEST workflow tools, skills, artifacts, or domain state.',
      )
    }

    const state = this.domainState.snapshot()
    const turnBoundary = buildTurnBoundary(plan.workflow?.action)
    const transition = workflowRunStartTransition({
      phase: state.phase,
      previousSceneId: typeof state.sceneId === 'string' ? state.sceneId : undefined,
      currentSceneId: this.options.sceneId,
    })
    if (transition.statePatch) this.domainState.applyPatch(transition.statePatch)
    for (const type of transition.staleArtifactTypes) {
      for (const artifact of this.artifacts.list(type)) this.artifacts.delete(artifact.id)
    }
    const boundaryTransition = workflowTurnBoundaryTransition(turnBoundary, this.domainState.snapshot())
    if (boundaryTransition.statePatch) this.domainState.applyPatch(boundaryTransition.statePatch)
    for (const type of boundaryTransition.staleArtifactTypes) {
      for (const artifact of this.artifacts.list(type)) this.artifacts.delete(artifact.id)
    }
    const objective = [
      `Current GSMS scene ID: ${this.options.sceneId}`,
      this.#history.length
        ? `Previous conversation summaries:\n${this.#history
            .slice(-6)
            .map(item => `- User: ${item.user}\n  Agent: ${item.summary}`)
            .join('\n')}`
        : '',
      `Current user request:\n${message}`,
      `Current phase: ${String(this.domainState.snapshot().phase ?? 'conversation-ready')}. ` +
      `Execution phases enforce strict sequential order; matching phases allow rollback and revision.`,
      `Top-level turn plan: ${JSON.stringify(summarizeTurnPlan(plan))}.`,
      turnBoundary
        ? `Hard turn boundary: ${JSON.stringify(turnBoundary)}. Tools outside this boundary are not visible and cannot satisfy this turn.`
        : '',
      'The current user request overrides earlier planning state. If it names or implies a different InVEST model, select that model again before matching or validation.',
      'Act on the current request using the persisted artifacts and domain state from this session.',
    ]
      .filter(Boolean)
      .join('\n\n')
    const runtime = new AgentRuntime({
      model: this.options.model,
      tools: workflowToolRegistry(this.options.tools),
      skills: this.options.skills,
      workspace: this.options.workspace,
      permissions: new PermissionManager({ approve: this.options.approve }),
      artifacts: this.artifacts,
      domainState: this.domainState,
      maxTurns: this.options.maxTurns,
      toolFilter: workflowPhaseFilter(this.options.tools.list(), turnBoundary),
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

  async #runPlainTurn(message: string, plan: TurnPlan, instruction: string): Promise<AgentRunResult> {
    const objective = [
      `Current user request:\n${message}`,
      `Top-level turn plan: ${JSON.stringify(summarizeTurnPlan(plan))}.`,
      instruction,
      this.#history.length
        ? `Previous conversation summaries:\n${this.#history
            .slice(-6)
            .map(item => `- User: ${item.user}\n  Agent: ${item.summary}`)
            .join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const runtime = new AgentRuntime({
      model: this.options.model,
      tools: this.#controlTools,
      skills: new SkillRegistry(),
      workspace: this.options.workspace,
      permissions: new PermissionManager({ approve: this.options.approve }),
      artifacts: new ArtifactStore(),
      domainState: new DomainStateStore(),
      maxTurns: Math.min(this.options.maxTurns, 6),
    })
    const result = await runtime.run(objective)
    this.#history.push({
      user: message,
      summary:
        result.goal.finalSummary ??
        result.goal.progress ??
        `${result.goal.status}; intent=${plan.intent}`,
    })
    return {
      ...result,
      artifacts: this.artifacts.list(),
      artifactLedger: this.artifacts.list(undefined, { includeSuperseded: true }),
      domainState: this.domainState.snapshot(),
    }
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
