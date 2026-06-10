import type {
  AgentActionEvent,
  AgentContext,
  AgentEventSink,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  Diagnostic,
  ToolCall,
  ToolProgressEvent,
} from '../types.ts'
import type { ToolRegistry } from '../tools/ToolRegistry.ts'
import type { Transcript } from '../transcript/Transcript.ts'

type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded'

interface TrackedTool {
  call: ToolCall
  tool: AgentTool | undefined
  status: ToolStatus
  isConcurrencySafe: boolean
  promise?: Promise<void>
  results?: AgentMessage[]
  pendingProgress: AgentMessage[]
}

export interface ToolExecutorResult {
  messages: AgentMessage[]
  diagnostics: Diagnostic[]
}

/**
 * Executes tools as they stream in with concurrency control.
 *
 * Runtime contract — every tool execution passes through `toolGuard`, which
 * re-checks tool visibility (skillScope, toolFilter) AND permissions at
 * execution time, not just at advertisement time.  This prevents the model
 * from executing hidden tools even if it guesses their names.
 *
 * Concurrency rules:
 * - Tools with `isConcurrencySafe === true` may execute in parallel.
 * - All other tools must execute alone (no concurrent tools at all).
 * - `isConcurrencySafe` is an explicit opt-in on the AgentTool interface;
 *   it is NOT derived from `risk`.
 *
 * Results are buffered and yielded in tool-registration order.
 *
 * Ported from Claude Code's StreamingToolExecutor.
 */
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private hasErrored = false
  private erroredToolDescription = ''
  private siblingAbortController: AbortController
  private discarded = false
  private progressAvailableResolve?: () => void
  private readonly diagnostics: Diagnostic[] = []
  private processQueueRunning = false
  private processQueueDone: Promise<void> = Promise.resolve()
  private resolveProcessQueueDone?: () => void

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly context: AgentContext,
    private readonly eventSink?: AgentEventSink,
    private readonly runId = '',
    private readonly turn = 0,
    private readonly toolGuard?: {
      check: (tool: AgentTool, input: unknown, context: AgentContext) => Promise<'allow' | 'deny' | 'defer'>
    },
    private readonly transcript?: Transcript,
    parentSignal?: AbortSignal,
  ) {
    this.siblingAbortController = new AbortController()
    if (parentSignal) {
      parentSignal.addEventListener('abort', () => {
        this.siblingAbortController.abort(parentSignal.reason)
      })
    }
  }

  discard(): void {
    this.discarded = true
  }

  /**
   * Register a tool call. Starts executing immediately if conditions allow.
   */
  addTool(call: ToolCall): void {
    const tool = this.toolRegistry.resolve(call.name)
    const isConcurrencySafe = tool?.isConcurrencySafe === true

    this.tools.push({
      call,
      tool,
      status: 'queued',
      isConcurrencySafe,
      pendingProgress: [],
    })

    // Start processing if not already running.
    if (!this.processQueueRunning) {
      this.processQueueRunning = true
      this.processQueueDone = new Promise<void>(resolve => {
        this.resolveProcessQueueDone = resolve
      })
      void this.processQueue()
    }
  }

  /**
   * Wait for all pending tool executions to complete.
   * In non-streaming mode, call this after addTool() to ensure all tools
   * have finished and their results are in the messages array before
   * continuing to the next turn.
   */
  async flush(): Promise<void> {
    while (this.processQueueRunning) {
      await this.processQueueDone
    }
  }

  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executingTools = this.tools.filter(t => t.status === 'executing')
    return (
      executingTools.length === 0 ||
      (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
    )
  }

  private async processQueue(): Promise<void> {
    try {
      let i = 0
      while (i < this.tools.length) {
        const tool = this.tools[i]
        if (!tool || tool.status !== 'queued') { i++; continue }

        // Stop processing if a previous tool deferred permission — the run
        // is now blocked and remaining tools must not execute.
        // Mark remaining queued tools as completed with cancellation so
        // getCompletedResults() can yield them and transition to 'yielded'.
        if (this.context.goal.status === 'blocked') {
          for (const remaining of this.tools.slice(i)) {
            if (remaining.status === 'queued') {
              remaining.status = 'completed'
              remaining.results = [{
                role: 'tool',
                toolCallId: remaining.call.id,
                content: 'Cancelled: run is blocked pending user confirmation',
                isError: true,
              }]
            }
          }
          break
        }

        if (this.canExecuteTool(tool.isConcurrencySafe)) {
          await this.executeTrackedTool(tool)
        } else {
          if (!tool.isConcurrencySafe) break
          i++
        }
      }
    } finally {
      this.processQueueRunning = false
      this.resolveProcessQueueDone?.()
    }
  }

  private async executeTrackedTool(tracked: TrackedTool): Promise<void> {
    // Don't start executing if the run is already blocked (e.g. a sibling
    // tool deferred permission).
    if (this.context.goal.status === 'blocked') {
      tracked.status = 'completed'
      tracked.results = [{
        role: 'tool',
        toolCallId: tracked.call.id,
        content: 'Cancelled: run is blocked pending user confirmation',
        isError: true,
      }]
      return
    }

    tracked.status = 'executing'

    const collectResults = async () => {
      const messages: AgentMessage[] = []

      // Check abort state
      if (this.discarded || this.hasErrored || this.siblingAbortController.signal.aborted) {
        const reason = this.discarded
          ? 'Streaming fallback - tool execution discarded'
          : this.hasErrored
            ? `Cancelled: parallel tool call ${this.erroredToolDescription} errored`
            : 'Cancelled'
        messages.push({
          role: 'tool',
          toolCallId: tracked.call.id,
          content: reason,
          isError: true,
        })
        tracked.results = messages
        tracked.status = 'completed'
        return
      }

      // Tool not found
      if (!tracked.tool) {
        const visibleTools = this.toolRegistry.list().map(t => t.name)
        messages.push({
          role: 'tool',
          toolCallId: tracked.call.id,
          content: `Unknown tool: ${tracked.call.name}. Available tools: ${visibleTools.join(', ')}`,
          isError: true,
        })
        tracked.results = messages
        tracked.status = 'completed'
        return
      }

      const tool = tracked.tool
      const startedAt = Date.now()

      // Record tool call in transcript for audit trail
      this.transcript?.record('tool_call', tracked.call)

      await this.emit({
        runId: this.runId,
        turn: this.turn,
        eventType: 'tool.started',
        summary: `Started ${tracked.call.name}`,
        status: 'started',
        toolCallId: tracked.call.id,
        data: { tool: tracked.call.name, input: sanitizeForEvent(tracked.call.input) },
        timestamp: new Date().toISOString(),
      })

      try {
        // ── Runtime contract: visibility + permission guard ──────────────
        // Re-check tool visibility (skillScope, toolFilter) AND permissions
        // at execution time.  This is the enforcement that prevents hidden
        // tools from being executed even if the model guesses their names.
        if (this.toolGuard) {
          const decision = await this.toolGuard.check(tool, tracked.call.input, this.context)
          if (decision === 'defer') {
            this.context.goal.status = 'blocked'
            this.context.goal.remainingIssues = [`Awaiting user confirmation for ${tool.name}`]
            // Abort sibling tools — the run is blocked, no further tools
            // should produce side-effects.
            this.siblingAbortController.abort('permission_deferred')
            messages.push({
              role: 'tool',
              toolCallId: tracked.call.id,
              content: `Permission deferred pending user confirmation: ${tool.name}`,
              isError: true,
            })
            await this.emit({
              runId: this.runId,
              turn: this.turn,
              eventType: 'tool.deferred',
              summary: `Waiting for user confirmation before ${tool.name}`,
              status: 'waiting',
              toolCallId: tracked.call.id,
              data: { tool: tool.name },
              durationMs: Date.now() - startedAt,
              timestamp: new Date().toISOString(),
            })
            tracked.results = messages
            tracked.status = 'completed'
            return
          }
          if (decision === 'deny') {
            messages.push({
              role: 'tool',
              toolCallId: tracked.call.id,
              content: `Tool not available: ${tool.name} is not permitted in the current workflow phase or skill scope.`,
              isError: true,
            })
            await this.emit({
              runId: this.runId,
              turn: this.turn,
              eventType: 'tool.failed',
              summary: `Denied ${tracked.call.name} — not visible in current scope`,
              status: 'failed',
              toolCallId: tracked.call.id,
              data: { tool: tool.name, reason: 'visibility_denied' },
              durationMs: Date.now() - startedAt,
              timestamp: new Date().toISOString(),
            })
            tracked.results = messages
            tracked.status = 'completed'
            return
          }
          // 'allow' — proceed
        }

        // Execute tool with onProgress callback
        const onProgress = (event: ToolProgressEvent) => {
          const progressMsg: AgentMessage = {
            role: 'user',
            content: event.message,
            hidden: true,
          }
          tracked.pendingProgress.push(progressMsg)
          if (this.progressAvailableResolve) {
            this.progressAvailableResolve()
            this.progressAvailableResolve = undefined
          }
          this.emit({
            runId: this.runId,
            turn: this.turn,
            eventType: 'tool.progress',
            summary: event.message,
            status: 'completed',
            toolCallId: tracked.call.id,
            data: { message: event.message, percentage: event.percentage },
            timestamp: new Date().toISOString(),
          })
        }

        const result = await tool.execute(tracked.call.input, this.context, onProgress)

        // Auto-persist large results to artifact to keep context window lean
        if (tool.persistResultAboveBytes && result.content.length > tool.persistResultAboveBytes) {
          const inputKey = JSON.stringify(tracked.call.input).slice(0, 120)
          const artifactId = `tool-result:${tool.name}:${inputKey}`
          // Replace previous auto-persist if any (idempotent)
          if (this.context.artifacts.list().some(a => a.id === artifactId)) {
            this.context.artifacts.delete(artifactId)
          }
          const persisted = this.context.artifacts.create({
            id: artifactId,
            type: 'tool-result',
            createdBy: 'tool' as const,
            data: { tool: tool.name, input: tracked.call.input, fullContent: result.content },
          })
          await this.emit({
            runId: this.runId,
            turn: this.turn,
            eventType: 'artifact.created',
            summary: `Persisted large output from ${tool.name} (${result.content.length} chars)`,
            status: 'completed',
            data: { artifactId: persisted.id, artifactType: 'tool-result' },
            timestamp: new Date().toISOString(),
          })
          const truncated = result.content.slice(0, 500)
          result.content = `${truncated}\n\n[Full result persisted as artifact "${artifactId}" (${result.content.length} chars). Use get_artifact to retrieve if needed.]`
        }

        // ── Process result ──────────────────────────────────────────────

        // Artifacts
        if (result.artifacts?.length) {
          const created = this.context.artifacts.createMany(result.artifacts)
          for (const artifact of created) {
            await this.emit({
              runId: this.runId,
              turn: this.turn,
              eventType: 'artifact.created',
              summary: `Created ${artifact.type} artifact`,
              status: 'completed',
              data: { artifactId: artifact.id, artifactType: artifact.type },
              timestamp: new Date().toISOString(),
            })
            this.transcript?.record('artifact', {
              action: 'created',
              id: artifact.id,
              type: artifact.type,
            })
          }
        }

        // Domain state
        if (result.statePatch) {
          const state = this.context.domainState.applyPatch(result.statePatch)
          await this.emit({
            runId: this.runId,
            turn: this.turn,
            eventType: 'state.changed',
            summary: `Updated workflow state${typeof state.phase === 'string' ? ` to ${state.phase}` : ''}`,
            status: 'completed',
            data: { patch: result.statePatch },
            timestamp: new Date().toISOString(),
          })
          this.transcript?.record('state', {
            action: 'patched',
            patch: result.statePatch,
          })
        }

        // Goal
        if (result.goalUpdate) Object.assign(this.context.goal, result.goalUpdate)

        // ── Runtime contract: activateSkill ─────────────────────────────
        // When a tool returns activateSkill, set the context's skillScope
        // so that subsequent tool executions are constrained to the skill's
        // allowed tools.  This is the enforcement of Skill boundaries.
        if (result.activateSkill) {
          this.context.skillScope = {
            name: result.activateSkill.name,
            allowedTools: new Set(result.activateSkill.allowedTools),
            activatedAtTurn: this.turn,
          }
          await this.emit({
            runId: this.runId,
            turn: this.turn,
            eventType: 'state.changed',
            summary: `Activated skill "${result.activateSkill.name}" with ${result.activateSkill.allowedTools.length} allowed tools`,
            status: 'completed',
            data: { skill: result.activateSkill.name, allowedTools: result.activateSkill.allowedTools },
            timestamp: new Date().toISOString(),
          })
        }

        // ── Runtime contract: diagnostics ───────────────────────────────
        if (result.diagnostics?.length) {
          this.diagnostics.push(...result.diagnostics)
          for (const diag of result.diagnostics) {
            this.transcript?.record('diagnostic', diag)
            await this.emit({
              runId: this.runId,
              turn: this.turn,
              eventType: 'diagnostic.created',
              summary: diag.message,
              status: diag.severity === 'error' ? 'failed' : 'completed',
              data: { code: diag.code, severity: diag.severity },
              timestamp: new Date().toISOString(),
            })
          }
        }

        messages.push({
          role: 'tool',
          toolCallId: tracked.call.id,
          content: result.content,
          isError: false,
        })

        await this.emit({
          runId: this.runId,
          turn: this.turn,
          eventType: 'tool.completed',
          summary: `Completed ${tracked.call.name}`,
          status: 'completed',
          toolCallId: tracked.call.id,
          data: { tool: tracked.call.name },
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        })

        // Hidden messages (e.g., workflow directives)
        if (result.hiddenMessages?.length) {
          messages.push(...result.hiddenMessages)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        messages.push({
          role: 'tool',
          toolCallId: tracked.call.id,
          content: message,
          isError: true,
        })

        // Track error for sibling cancellation
        this.hasErrored = true
        this.erroredToolDescription = tracked.call.name
        this.siblingAbortController.abort('sibling_error')

        await this.emit({
          runId: this.runId,
          turn: this.turn,
          eventType: 'tool.failed',
          summary: `Failed ${tracked.call.name}: ${message.slice(0, 200)}`,
          status: 'failed',
          toolCallId: tracked.call.id,
          data: { tool: tracked.call.name, error: message.slice(0, 200) },
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        })
      }

      tracked.results = messages
      tracked.status = 'completed'
    }

    const promise = collectResults()
    tracked.promise = promise
    await promise
  }

  /**
   * Get completed results that haven't been yielded yet (non-blocking).
   * Yields progress messages immediately regardless of tool completion status.
   * Results are yielded in tool registration order.
   */
  *getCompletedResults(): Generator<AgentMessage, void> {
    if (this.discarded) return

    for (const tool of this.tools) {
      // Always yield pending progress messages immediately
      while (tool.pendingProgress.length > 0) {
        yield tool.pendingProgress.shift()!
      }

      if (tool.status === 'yielded') continue

      if (tool.status === 'completed' && tool.results) {
        tool.status = 'yielded'
        yield* tool.results
      } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
        break
      }
    }
  }

  /**
   * Wait for remaining tools and yield their results as they complete.
   */
  async *getRemainingResults(): AsyncGenerator<AgentMessage, void> {
    if (this.discarded) return

    while (this.hasUnfinishedTools()) {
      await this.processQueue()

      for (const result of this.getCompletedResults()) {
        yield result
      }

      if (
        this.hasExecutingTools() &&
        !this.hasCompletedResults() &&
        !this.hasPendingProgress()
      ) {
        const executingPromises = this.tools
          .filter(t => t.status === 'executing' && t.promise)
          .map(t => t.promise!)

        const progressPromise = new Promise<void>(resolve => {
          this.progressAvailableResolve = resolve
        })

        if (executingPromises.length > 0) {
          await Promise.race([...executingPromises, progressPromise])
        }
      }
    }

    for (const result of this.getCompletedResults()) {
      yield result
    }
  }

  private hasPendingProgress(): boolean {
    return this.tools.some(t => t.pendingProgress.length > 0)
  }

  private hasCompletedResults(): boolean {
    return this.tools.some(t => t.status === 'completed')
  }

  private hasExecutingTools(): boolean {
    return this.tools.some(t => t.status === 'executing')
  }

  private hasUnfinishedTools(): boolean {
    return this.tools.some(t => t.status !== 'yielded')
  }

  hasBlockedOnPermission(): boolean {
    return this.context.goal.status === 'blocked'
  }

  /**
   * Diagnostics collected from tool results during this executor's lifetime.
   */
  get collectedDiagnostics(): readonly Diagnostic[] {
    return this.diagnostics
  }

  private async emit(event: AgentActionEvent): Promise<void> {
    try {
      await this.eventSink?.emit(event)
    } catch {
      // Observability must never prevent the Agent from completing its work.
    }
  }
}

function summarizeText(value: string, maxLength = 1000): string {
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
