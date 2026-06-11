import type {
  AgentContext,
  AgentEventSink,
  AgentMessage,
  AgentTool,
  Diagnostic,
  ToolCall,
} from '../types.ts'
import type { ToolRegistry } from '../tools/ToolRegistry.ts'
import type { Transcript } from '../transcript/Transcript.ts'
import { executeToolCall } from './ToolExecutionHost.ts'

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
 * Concurrency model (currently serial; opt-in for future parallelism):
 * - Tools with `isConcurrencySafe === true` MAY execute in parallel, but
 *   this capability is NOT yet used — no GSMS tool declares it, and the
 *   default is false. All tools currently execute one at a time.
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

      // Tool not found — do NOT echo the full tool registry (enumeration leak).
      // The model can discover available tools from the system prompt or by
      // calling ToolSearch; the error just names the unknown tool.
      if (!tracked.tool) {
        messages.push({
          role: 'tool',
          toolCallId: tracked.call.id,
          content: `Unknown tool: ${tracked.call.name}.`,
          isError: true,
        })
        tracked.results = messages
        tracked.status = 'completed'
        return
      }

      const tool = tracked.tool

      const execution = await executeToolCall({
        tool,
        call: tracked.call,
        context: this.context,
        eventSink: this.eventSink,
        runId: this.runId,
        turn: this.turn,
        guard: this.toolGuard,
        transcript: this.transcript,
        diagnostics: this.diagnostics,
        onProgressMessage: message => {
          tracked.pendingProgress.push(message)
          if (this.progressAvailableResolve) {
            this.progressAvailableResolve()
            this.progressAvailableResolve = undefined
          }
        },
      })
      messages.push(...execution.messages)
      if (execution.deferred) {
        this.siblingAbortController.abort('permission_deferred')
      }
      if (execution.outcome === 'failed') {
        this.hasErrored = true
        this.erroredToolDescription = tracked.call.name
        this.siblingAbortController.abort('sibling_error')
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

}
