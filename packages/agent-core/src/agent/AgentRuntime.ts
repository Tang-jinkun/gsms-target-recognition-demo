import type { SkillRegistry } from '@gsms/skills-core'
import { ArtifactStore } from '../artifacts/ArtifactStore.ts'
import { PermissionManager } from '../permissions/PermissionManager.ts'
import { buildSystemPrompt } from '../prompts/buildSystemPrompt.ts'
import { DomainStateStore } from '../state/DomainStateStore.ts'
import { ToolRegistry } from '../tools/ToolRegistry.ts'
import { Transcript } from '../transcript/Transcript.ts'
import type {
  AgentContext,
  AgentActionEvent,
  AgentMessage,
  AgentRunResult,
  ArtifactRepository,
  Diagnostic,
  DomainState,
  DomainStateRepository,
  GoalState,
  AgentEventSink,
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
  maxRepeatedToolCalls?: number
  eventSink?: AgentEventSink
  signal?: AbortSignal
}

export class AgentRuntime {
  readonly #permissions: PermissionManager

  constructor(readonly options: AgentRuntimeOptions) {
    this.#permissions = options.permissions ?? new PermissionManager()
  }

  async run(objective: string): Promise<AgentRunResult> {
    const runId = createRunId()
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
    const toolCallHistory: string[] = []
    await this.#emit({
      runId,
      turn: 0,
      eventType: 'run.started',
      summary: 'Agent run started',
      status: 'started',
      timestamp: new Date().toISOString(),
    })

    while (goal.status === 'active' && goal.turnCount < goal.maxTurns) {
      this.options.signal?.throwIfAborted()
      goal.turnCount++
      const response = await this.options.model.complete({
        messages,
        tools: this.#visibleToolDefinitions(context),
        signal: this.options.signal,
      })
      await this.#emit({
        runId,
        turn: goal.turnCount,
        eventType: 'model.responded',
        summary: response.toolCalls?.length
          ? `Model selected ${response.toolCalls.map(call => call.name).join(', ')}`
          : 'Model responded without a tool call',
        status: 'completed',
        data: {
          toolNames: response.toolCalls?.map(call => call.name) ?? [],
          hasVisibleContent: Boolean(response.content.trim()),
        },
        timestamp: new Date().toISOString(),
      })
      const assistant: AgentMessage = {
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      }
      messages.push(assistant)
      transcript.record('message', assistant)

      if (!response.toolCalls?.length) {
        toolCallHistory.length = 0
        messages.push({
          role: 'user',
          content: 'Continue acting toward the objective. Use finish when done.',
          hidden: true,
        })
        continue
      }

      const toolCallSignature = canonicalToolCalls(response.toolCalls)
      toolCallHistory.push(toolCallSignature)
      const maxRepeatedToolCalls = this.options.maxRepeatedToolCalls ?? 4
      const repeatedCycle = findRepeatedCycle(toolCallHistory, maxRepeatedToolCalls)
      if (repeatedCycle) {
        const summary = repeatedCycle.join(' -> ')
        const diagnostic: Diagnostic = {
          code: 'AGENT_REPEATED_TOOL_CALL_LOOP',
          message: `Detected a tool-call cycle repeated ${maxRepeatedToolCalls} times: ${summary}`,
          severity: 'error',
        }
        diagnostics.push(diagnostic)
        transcript.record('diagnostic', diagnostic)
        await this.#emit({
          runId,
          turn: goal.turnCount,
          eventType: 'loop.detected',
          summary: diagnostic.message,
          status: 'failed',
          data: { code: diagnostic.code },
          timestamp: new Date().toISOString(),
        })
        goal.status = 'failed'
        goal.remainingIssues.push(diagnostic.message)
        break
      }

      const pendingHiddenMessages: AgentMessage[] = []
      for (const call of response.toolCalls) {
        pendingHiddenMessages.push(
          ...(await this.#executeTool(call, context, messages, transcript, diagnostics, runId)),
        )
        if (goal.status !== 'active') break
      }
      messages.push(...pendingHiddenMessages)
    }

    if (goal.status === 'active') {
      goal.status = 'failed'
      const recentToolCalls = transcript.events
        .filter(event => event.type === 'tool_call')
        .slice(-8)
        .map(event => summarizeToolCalls([event.data as ToolCall]))
      const trace = recentToolCalls.length
        ? ` Recent tool calls: ${recentToolCalls.join(' -> ')}`
        : ''
      const message = `Reached maximum turns (${goal.maxTurns}).${trace}`
      goal.remainingIssues.push(message)
      const diagnostic: Diagnostic = {
        code: 'AGENT_MAX_TURNS_REACHED',
        message,
        severity: 'error',
      }
      diagnostics.push(diagnostic)
      transcript.record('diagnostic', diagnostic)
      await this.#emit({
        runId,
        turn: goal.turnCount,
        eventType: 'diagnostic.created',
        summary: diagnostic.message,
        status: 'failed',
        data: { code: diagnostic.code },
        timestamp: new Date().toISOString(),
      })
    }
    await this.#emit({
      runId,
      turn: goal.turnCount,
      summary:
        goal.finalSummary ??
        goal.remainingIssues.join('; ') ??
        `Agent run ended with status ${goal.status}`,
      eventType:
        goal.status === 'completed'
          ? 'run.completed'
          : goal.status === 'blocked'
            ? 'run.paused'
            : 'run.failed',
      status: goal.status === 'completed' ? 'completed' : goal.status === 'blocked' ? 'waiting' : 'failed',
      data: { goalStatus: goal.status },
      timestamp: new Date().toISOString(),
    })
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
    runId: string,
  ): Promise<AgentMessage[]> {
    const startedAt = Date.now()
    await this.#emit({
      runId,
      turn: context.goal.turnCount,
      eventType: 'tool.started',
      summary: `Started ${call.name}`,
      status: 'started',
      toolCallId: call.id,
      data: { tool: call.name, input: sanitizeForEvent(call.input) },
      timestamp: new Date().toISOString(),
    })
    transcript.record('tool_call', call)
    const tool = this.options.tools.resolve(call.name)
    if (!tool) {
      this.#pushToolResult(messages, transcript, call, `Unknown tool: ${call.name}`, true)
      await this.#emitToolFailure(runId, context.goal.turnCount, call, startedAt, `Unknown tool: ${call.name}`)
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
        await this.#emit({
          runId,
          turn: context.goal.turnCount,
          eventType: 'tool.deferred',
          summary: `Waiting for user confirmation before ${tool.name}`,
          status: 'waiting',
          toolCallId: call.id,
          data: { tool: call.name },
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        })
        return []
      }
      if (decision !== 'allow') {
      this.#pushToolResult(messages, transcript, call, `Permission denied: ${tool.name}`, true)
      await this.#emitToolFailure(runId, context.goal.turnCount, call, startedAt, `Permission denied: ${tool.name}`)
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
        for (const artifact of created) {
          transcript.record('artifact', artifact)
          await this.#emit({
            runId,
            turn: context.goal.turnCount,
            eventType: 'artifact.created',
            summary: `Created ${artifact.type} artifact`,
            status: 'completed',
            data: { artifactId: artifact.id, artifactType: artifact.type },
            timestamp: new Date().toISOString(),
          })
        }
      }
      if (result.statePatch) {
        const state = context.domainState.applyPatch(result.statePatch)
        transcript.record('state', { patch: result.statePatch, state })
        await this.#emit({
          runId,
          turn: context.goal.turnCount,
          eventType: 'state.changed',
          summary: `Updated workflow state${typeof state.phase === 'string' ? ` to ${state.phase}` : ''}`,
          status: 'completed',
          data: { patch: sanitizeForEvent(result.statePatch) },
          timestamp: new Date().toISOString(),
        })
      }
      if (result.diagnostics?.length) {
        diagnostics.push(...result.diagnostics)
        for (const diagnostic of result.diagnostics) {
          transcript.record('diagnostic', diagnostic)
          await this.#emit({
            runId,
            turn: context.goal.turnCount,
            eventType: 'diagnostic.created',
            summary: diagnostic.message,
            status: diagnostic.severity === 'error' ? 'failed' : 'completed',
            data: { code: diagnostic.code, severity: diagnostic.severity },
            timestamp: new Date().toISOString(),
          })
        }
      }
      this.#pushToolResult(messages, transcript, call, result.content, false)
      await this.#emit({
        runId,
        turn: context.goal.turnCount,
        eventType: 'tool.completed',
        summary: `Completed ${call.name}`,
        status: 'completed',
        toolCallId: call.id,
        data: { tool: call.name },
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      })
      return result.hiddenMessages ?? []
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#pushToolResult(
        messages,
        transcript,
        call,
        message,
        true,
      )
      await this.#emitToolFailure(runId, context.goal.turnCount, call, startedAt, message)
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

  async #emit(event: AgentActionEvent): Promise<void> {
    try {
      await this.options.eventSink?.emit(event)
    } catch {
      // Observability must never prevent the Agent from completing its work.
    }
  }

  #emitToolFailure(
    runId: string,
    turn: number,
    call: ToolCall,
    startedAt: number,
    message: string,
  ): Promise<void> {
    return this.#emit({
      runId,
      turn,
      eventType: 'tool.failed',
      summary: `Failed ${call.name}: ${summarizeText(message)}`,
      status: 'failed',
      toolCallId: call.id,
      data: { tool: call.name, error: summarizeText(message) },
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    })
  }
}

function canonicalToolCalls(calls: readonly ToolCall[]): string {
  return calls.map(call => `${call.name}:${canonical(call.input)}`).join('|')
}

function findRepeatedCycle(history: readonly string[], repetitions: number): string[] | undefined {
  const maxCycleLength = Math.min(6, Math.floor(history.length / repetitions))
  for (let cycleLength = 1; cycleLength <= maxCycleLength; cycleLength++) {
    const cycle = history.slice(-cycleLength)
    const repeated = Array.from({ length: repetitions }, () => cycle).flat()
    if (
      history.length >= repeated.length &&
      history.slice(-repeated.length).every((signature, index) => signature === repeated[index])
    ) {
      return cycle
    }
  }
  return undefined
}

function summarizeToolCalls(calls: readonly ToolCall[]): string {
  return calls
    .map(call => {
      const input = canonical(call.input)
      return `${call.name}(${input.length > 160 ? `${input.slice(0, 157)}...` : input})`
    })
    .join(', ')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function createRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function summarizeText(value: string, maxLength = 500): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact
}

function sanitizeForEvent(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeForEvent(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, item]) => [
          key,
          /api.?key|token|secret|password|authorization/i.test(key)
            ? '[redacted]'
            : sanitizeForEvent(item, depth + 1),
        ]),
    )
  }
  if (typeof value === 'string') return summarizeText(value, 1000)
  return value
}
