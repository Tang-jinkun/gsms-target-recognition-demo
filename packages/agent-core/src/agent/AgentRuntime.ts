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
  AgentTool,
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
    let noProgressCount = 0
    const maxNoProgressSteer = 2   // inject steering after this many no-progress turns
    const maxNoProgressStop = 4    // force stop after this many no-progress turns
    let failedToolName: string | undefined
    let failedToolCount = 0
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
      const artifactCountBefore = artifacts.list().length
      const canonicalStateBefore = canonical(domainState.snapshot())

      const visibleTools = this.#visibleToolDefinitions(context)
      const modelRequest = {
        messages,
        tools: visibleTools,
        signal: this.options.signal,
      }

      // Create executor for this turn.
      // toolGuard re-checks visibility (skillScope + toolFilter) AND permissions
      // at execution time — this is the enforcement that prevents hidden tools
      // from being executed even if the model guesses their names.
      const toolGuard = {
        check: async (tool: AgentTool, input: unknown, ctx: AgentContext): Promise<'allow' | 'deny' | 'defer'> => {
          if (!this.#isToolVisible(tool, ctx)) return 'deny'
          return this.#permissions.check(tool, input, ctx)
        },
      }
      const executor = new StreamingToolExecutor(
        this.options.tools,
        context,
        this.options.eventSink,
        runId,
        goal.turnCount,
        toolGuard,
        transcript,
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

      if (!response.toolCalls?.length) {
        toolCallHistory.length = 0
        messages.push({
          role: 'user',
          content: 'Continue acting toward the objective. Use finish when done.',
          hidden: true,
        })
        continue
      }

      // Loop detection — MUST happen before tool execution to prevent
      // the triggering call from executing.
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

      // Register tools AFTER loop detection.
      // In non-streaming mode, register and execute tools now.
      // In streaming mode, tools were already registered during #streamWithExecutor.
      if (!this.options.model.completeStreaming) {
        for (const call of response.toolCalls) {
          executor.addTool(call)
        }
        await executor.flush()
      }

      // Collect tool results from executor.
      // Hidden messages (skill instructions, progress) are collected
      // separately and pushed AFTER all tool results, so they don't
      // interleave between assistant/tool message pairs.
      const pendingHiddenMessages: AgentMessage[] = []
      for (const msg of executor.getCompletedResults()) {
        if ('hidden' in msg && msg.hidden) {
          pendingHiddenMessages.push(msg)
          transcript.record('message', msg)
          continue
        }
        messages.push(msg)
        if (msg.role === 'tool') transcript.record('tool_result', msg)
      }

      // Wait for remaining tools
      for await (const msg of executor.getRemainingResults()) {
        if ('hidden' in msg && msg.hidden) {
          pendingHiddenMessages.push(msg)
          transcript.record('message', msg)
          continue
        }
        messages.push(msg)
        if (msg.role === 'tool') transcript.record('tool_result', msg)
      }

      // Push hidden messages after all tool results
      messages.push(...pendingHiddenMessages)

      // Check if blocked (permission deferred)
      if (executor.hasBlockedOnPermission()) {
        break
      }

      // Merge diagnostics collected by the executor (from tool result.diagnostics)
      if (executor.collectedDiagnostics.length > 0) {
        diagnostics.push(...executor.collectedDiagnostics)
      }

      // Per-tool failure loop detection: if the same tool fails 3 consecutive
      // times without producing new artifacts or state changes, stop the run.
      // This is a strict guard against a tool that is fundamentally broken.
      {
        let toolFailedWithoutProgress = false
        for (const call of response.toolCalls) {
          const toolResult = [...messages].reverse().find(
            m => m.role === 'tool' && m.toolCallId === call.id,
          )
          if (toolResult?.role !== 'tool' || !toolResult.isError) {
            // Successful tool — reset per-tool failure counter
            failedToolName = undefined
            failedToolCount = 0
            continue
          }
          // Tool failed — check if it produced any side-effects
          const madeProgress =
            artifacts.list().length > artifactCountBefore ||
            canonical(domainState.snapshot()) !== canonicalStateBefore
          if (madeProgress) {
            failedToolName = undefined
            failedToolCount = 0
            continue
          }
          if (failedToolName === call.name) {
            failedToolCount++
          } else {
            failedToolName = call.name
            failedToolCount = 1
          }
          if (failedToolCount >= 3) {
            const diagnostic: Diagnostic = {
              code: 'AGENT_TOOL_FAILURE_LOOP',
              message: `Tool ${call.name} failed ${failedToolCount} consecutive times without producing progress. Last error: ${summarizeText(toolResult.content)}`,
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
              data: { code: diagnostic.code, tool: call.name, failedToolCount },
              timestamp: new Date().toISOString(),
            })
            goal.status = 'failed'
            goal.remainingIssues.push(diagnostic.message)
            toolFailedWithoutProgress = true
            break
          }
        }
        if (toolFailedWithoutProgress) break
      }

      // Diminishing-returns detection: if no new artifacts were created this
      // turn AND at least one tool failed, the agent is likely stuck.
      // After maxNoProgressSteer consecutive stuck turns, inject a steering
      // message; after maxNoProgressStop, force-stop the run.
      //
      // Note: successful tool calls that don't create artifacts (e.g.
      // read_file, write_file) are NOT counted as "no progress" — the agent
      // made progress by successfully executing a tool.  Only failures
      // without side-effects count toward the diminishing-returns counter.
      const lastToolResult = [...messages].reverse().find(
        m => m.role === 'tool' && m.toolCallId,
      )
      const lastToolFailed = lastToolResult?.role === 'tool' && lastToolResult.isError
      const noNewArtifacts = artifacts.list().length === artifactCountBefore
      if (lastToolFailed && noNewArtifacts) {
        noProgressCount++
        if (noProgressCount === maxNoProgressSteer) {
          messages.push({
            role: 'user',
            content: 'You have been repeating the same actions without producing new evidence or artifacts. If the objective is complete, call finish now. If you are stuck, change your approach or call finish with what you have so far.',
            hidden: true,
          })
          transcript.record('message', { role: 'user', content: '[steering] diminishing-returns warning injected', hidden: true })
        }
        if (noProgressCount >= maxNoProgressStop) {
          const diagnostic: Diagnostic = {
            code: 'AGENT_NO_PROGRESS',
            message: `Agent produced no new artifacts for ${noProgressCount} consecutive failing turns — stopping.`,
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
            data: { code: diagnostic.code, noProgressCount },
            timestamp: new Date().toISOString(),
          })
          goal.status = 'failed'
          goal.remainingIssues.push(diagnostic.message)
          break
        }
      } else {
        noProgressCount = 0
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
    request: { messages: readonly AgentMessage[]; tools: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[]; signal?: AbortSignal },
    executor: StreamingToolExecutor,
    runId: string,
    turn: number,
  ): Promise<ModelResponse> {
    let content = ''
    const toolCallAccumulator = new Map<number, { id: string; name: string; arguments: string }>()
    let lastCompletedId: string | undefined

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
          await this.#emit({
            runId,
            turn,
            eventType: 'model.streaming',
            summary: chunk.text,
            status: 'completed',
            data: { text: chunk.text },
            timestamp: new Date().toISOString(),
          })
          break
        case 'tool_call_start':
          // Emit tool start as streaming event so frontend can show tool card immediately
          await this.#emit({
            runId,
            turn,
            eventType: 'model.streaming',
            summary: `tool_call: ${chunk.name}`,
            status: 'completed',
            data: { tool: chunk.name, tool_call_id: chunk.id },
            timestamp: new Date().toISOString(),
          })
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
