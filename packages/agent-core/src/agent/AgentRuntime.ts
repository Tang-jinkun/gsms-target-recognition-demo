import type { SkillRegistry } from '@gsms/skills-core'
import { ArtifactStore } from '../artifacts/ArtifactStore.ts'
import { PermissionManager } from '../permissions/PermissionManager.ts'
import { buildSystemPrompt } from '../prompts/buildSystemPrompt.ts'
import { DomainStateStore } from '../state/DomainStateStore.ts'
import { ToolRegistry } from '../tools/ToolRegistry.ts'
import { Transcript } from '../transcript/Transcript.ts'
import type {
  AgentContext,
  AgentMessage,
  AgentRunResult,
  ArtifactRepository,
  Diagnostic,
  DomainState,
  DomainStateRepository,
  GoalState,
  ModelAdapter,
  ToolCall,
} from '../types.ts'

export interface AgentRuntimeOptions {
  model: ModelAdapter
  tools: ToolRegistry
  skills: SkillRegistry
  workspace: string
  permissions?: PermissionManager
  artifacts?: ArtifactRepository
  domainState?: DomainStateRepository
  initialDomainState?: DomainState
  maxTurns?: number
  signal?: AbortSignal
}

export class AgentRuntime {
  readonly #permissions: PermissionManager

  constructor(readonly options: AgentRuntimeOptions) {
    this.#permissions = options.permissions ?? new PermissionManager()
  }

  async run(objective: string): Promise<AgentRunResult> {
    const goal: GoalState = {
      objective,
      status: 'active',
      turnCount: 0,
      maxTurns: this.options.maxTurns ?? 20,
      evidence: [],
      remainingIssues: [],
      startedAt: new Date().toISOString(),
    }
    const messages: AgentMessage[] = [
      { role: 'system', content: buildSystemPrompt(goal, this.options.skills) },
      { role: 'user', content: objective },
    ]
    const transcript = new Transcript()
    const artifacts = this.options.artifacts ?? new ArtifactStore()
    const domainState =
      this.options.domainState ?? new DomainStateStore(this.options.initialDomainState)
    const diagnostics: Diagnostic[] = []
    const context: AgentContext = {
      workspace: this.options.workspace,
      goal,
      artifacts,
      domainState,
      signal: this.options.signal,
    }

    while (goal.status === 'active' && goal.turnCount < goal.maxTurns) {
      this.options.signal?.throwIfAborted()
      goal.turnCount++
      const response = await this.options.model.complete({
        messages,
        tools: this.#visibleToolDefinitions(context),
        signal: this.options.signal,
      })
      const assistant: AgentMessage = {
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      }
      messages.push(assistant)
      transcript.record('message', assistant)

      if (!response.toolCalls?.length) {
        messages.push({
          role: 'user',
          content: 'Continue acting toward the objective. Use finish when done.',
          hidden: true,
        })
        continue
      }

      const pendingHiddenMessages: AgentMessage[] = []
      for (const call of response.toolCalls) {
        pendingHiddenMessages.push(
          ...(await this.#executeTool(call, context, messages, transcript, diagnostics)),
        )
        if (goal.status !== 'active') break
      }
      messages.push(...pendingHiddenMessages)
    }

    if (goal.status === 'active') {
      goal.status = 'failed'
      goal.remainingIssues.push(`Reached maximum turns (${goal.maxTurns})`)
    }
    transcript.record('goal', goal)
    return {
      goal,
      messages,
      transcript: transcript.events,
      artifacts: artifacts.list(),
      domainState: domainState.snapshot(),
      diagnostics,
    }
  }

  #visibleToolDefinitions(context: AgentContext) {
    return this.options.tools
      .list()
      .filter(
        tool =>
          tool.risk === 'control' ||
          !context.skillScope ||
          context.skillScope.allowedTools.has(tool.name),
      )
      .map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }))
  }

  async #executeTool(
    call: ToolCall,
    context: AgentContext,
    messages: AgentMessage[],
    transcript: Transcript,
    diagnostics: Diagnostic[],
  ): Promise<AgentMessage[]> {
    transcript.record('tool_call', call)
    const tool = this.options.tools.resolve(call.name)
    if (!tool) {
      this.#pushToolResult(messages, transcript, call, `Unknown tool: ${call.name}`, true)
      return []
    }

      const decision = await this.#permissions.check(tool, call.input, context)
      transcript.record('permission', { tool: tool.name, decision })
      if (decision === 'defer') {
        context.goal.status = 'blocked'
        context.goal.remainingIssues = [`Awaiting user confirmation for ${tool.name}`]
        this.#pushToolResult(
          messages,
          transcript,
          call,
          `Permission deferred pending user confirmation: ${tool.name}`,
          true,
        )
        return []
      }
      if (decision !== 'allow') {
      this.#pushToolResult(messages, transcript, call, `Permission denied: ${tool.name}`, true)
      return []
    }

    try {
      const result = await tool.execute(call.input, context)
      if (result.activateSkill) {
        context.skillScope = {
          name: result.activateSkill.name,
          allowedTools: new Set(result.activateSkill.allowedTools),
          activatedAtTurn: context.goal.turnCount,
        }
      }
      if (result.goalUpdate) Object.assign(context.goal, result.goalUpdate)
      if (result.artifacts?.length) {
        const created = context.artifacts.createMany(result.artifacts)
        for (const artifact of created) transcript.record('artifact', artifact)
      }
      if (result.statePatch) {
        const state = context.domainState.applyPatch(result.statePatch)
        transcript.record('state', { patch: result.statePatch, state })
      }
      if (result.diagnostics?.length) {
        diagnostics.push(...result.diagnostics)
        for (const diagnostic of result.diagnostics) transcript.record('diagnostic', diagnostic)
      }
      this.#pushToolResult(messages, transcript, call, result.content, false)
      return result.hiddenMessages ?? []
    } catch (error) {
      this.#pushToolResult(
        messages,
        transcript,
        call,
        error instanceof Error ? error.message : String(error),
        true,
      )
      return []
    }
  }

  #pushToolResult(
    messages: AgentMessage[],
    transcript: Transcript,
    call: ToolCall,
    content: string,
    isError: boolean,
  ): void {
    const message: AgentMessage = {
      role: 'tool',
      toolCallId: call.id,
      content,
      isError,
    }
    messages.push(message)
    transcript.record('tool_result', message)
  }
}
