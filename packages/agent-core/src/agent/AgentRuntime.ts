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
  ModelResponse,
  ToolCall,
} from '../types.ts'
import { StreamingToolExecutor } from './StreamingToolExecutor.ts'

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
  toolFilter?: (tool: ReturnType<ToolRegistry['list']>[number], context: AgentContext) => boolean
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

      const visibleTools = this.#visibleToolDefinitions(context)
      const modelRequest = {
        messages,
        tools: visibleTools,
        signal: this.options.signal,
      }

      // Create executor for this turn
      const executor = new StreamingToolExecutor(
        this.options.tools,
        context,
        this.options.eventSink,
        runId,
        goal.turnCount,
        this.#permissions,
        this.options.signal,
      )

      let response: ModelResponse

      if (this.options.model.completeStreaming) {
        // Streaming mode: start executing tools as they arrive
        response = await this.#streamWithExecutor(modelRequest, executor, runId, goal.turnCount)
      } else {
        // Non-streaming mode: wait for full response, then execute tools
        response = await this.options.model.complete(modelRequest)
      }

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

      // In non-streaming mode, register tools after model.responded event
      // (streaming mode already registered them during #streamWithExecutor)
      if (!this.options.model.completeStreaming) {
        for (const call of response.toolCalls ?? []) {
          executor.addTool(call)
        }
      }

      if (!response.toolCalls?.length) {
        toolCallHistory.length = 0
        messages.push({
          role: 'user',
          content: 'Continue acting toward the objective. Use finish when done.',
          hidden: true,
        })
        continue
      }

      // Loop detection
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

      // Collect tool results from executor
      for (const msg of executor.getCompletedResults()) {
        messages.push(msg)
        if (msg.role === 'tool') transcript.record('tool_result', msg)
      }

      // Wait for remaining tools
      for await (const msg of executor.getRemainingResults()) {
        messages.push(msg)
        if (msg.role === 'tool') transcript.record('tool_result', msg)
      }

      // Check if blocked (permission deferred)
      if (executor.hasBlockedOnPermission()) {
        break
      }

      // Tool failure tracking
      const toolResults = messages.filter(m => m.role === 'tool' && m.toolCallId)
      const lastToolResult = toolResults[toolResults.length - 1]
      if (lastToolResult?.isError) {
        const failedCall = response.toolCalls.find(c => c.id === lastToolResult.toolCallId)
        if (failedCall) {
          const diagnostic: Diagnostic = {
            code: 'AGENT_TOOL_FAILURE',
            message: `Tool ${failedCall.name} failed: ${summarizeText(lastToolResult.content)}`,
            severity: 'error',
          }
          diagnostics.push(diagnostic)
          transcript.record('diagnostic', diagnostic)
        }
      }

      if (goal.status !== 'active') break
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

  /**
   * Streaming mode: process model stream and start executing tools as they arrive.
   */
  async #streamWithExecutor(
    request: { messages: readonly AgentMessage[]; tools: readonly ReturnType<ToolRegistry['list']>[number][]; signal?: AbortSignal },
    executor: StreamingToolExecutor,
    runId: string,
    turn: number,
  ): Promise<ModelResponse> {
    let content = ''
    const toolCallAccumulator = new Map<number, { id: string; name: string; arguments: string }>()
    let lastCompletedId: string | undefined
    let streamBuffer = ''

    const flushStreamBuffer = async () => {
      if (!streamBuffer) return
      await this.#emit({
        runId,
        turn,
        eventType: 'model.streaming',
        summary: streamBuffer,
        status: 'completed',
        data: { text: streamBuffer },
        timestamp: new Date().toISOString(),
      })
      streamBuffer = ''
    }

    const finalizeToolCall = () => {
      if (lastCompletedId === undefined) return
      const tc = toolCallAccumulator.get([...toolCallAccumulator.values()].findIndex(t => t.id === lastCompletedId))
      if (tc && tc.arguments) {
        executor.addTool({
          id: tc.id,
          name: tc.name,
          input: parseArguments(tc.arguments),
        })
      }
      lastCompletedId = undefined
    }

    for await (const chunk of this.options.model.completeStreaming!(request)) {
      switch (chunk.type) {
        case 'text':
          content += chunk.text
          streamBuffer += chunk.text
          if (/[.!?]\s/.test(streamBuffer) || /\n/.test(streamBuffer) || streamBuffer.length >= 100) {
            await flushStreamBuffer()
          }
          break
        case 'tool_call_start':
          await flushStreamBuffer()
          // Finalize previous tool call if any
          finalizeToolCall()
          toolCallAccumulator.set(toolCallAccumulator.size, {
            id: chunk.id,
            name: chunk.name,
            arguments: '',
          })
          lastCompletedId = chunk.id
          break
        case 'tool_call_delta': {
          const entry = [...toolCallAccumulator.values()].find(tc => tc.id === chunk.id)
          if (entry) entry.arguments += chunk.argumentsDelta
          break
        }
        case 'done':
          finalizeToolCall()
          break
      }
    }

    // Flush remaining streaming text buffer
    await flushStreamBuffer()

    // Finalize any remaining tool call (stream ended without 'done')
    finalizeToolCall()

    const toolCalls = [...toolCallAccumulator.values()].map(tc => ({
      id: tc.id,
      name: tc.name,
      input: parseArguments(tc.arguments),
    }))

    return {
      content,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    }
  }

  #visibleToolDefinitions(context: AgentContext) {
    return this.options.tools
      .list()
      .filter(tool => this.#isToolVisible(tool, context))
      .map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }))
  }

  #isToolVisible(tool: ReturnType<ToolRegistry['list']>[number], context: AgentContext): boolean {
    return (
      (tool.risk === 'control' ||
        !context.skillScope ||
        context.skillScope.allowedTools.has(tool.name)) &&
      (this.options.toolFilter?.(tool, context) ?? true)
    )
  }

  async #emit(event: AgentActionEvent): Promise<void> {
    try {
      await this.options.eventSink?.emit(event)
    } catch {
      // Observability must never prevent the Agent from completing its work.
    }
  }
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return {}
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
