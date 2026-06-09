import type {
  AgentActionEvent,
  AgentContext,
  AgentEventSink,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  ToolCall,
  ToolProgressEvent,
} from '../types.ts'
import type { ToolRegistry } from '../tools/ToolRegistry.ts'

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
  diagnostics: Array<{ code: string; message: string; severity: string }>
}

/**
 * Executes tools as they stream in with concurrency control.
 * - Concurrent-safe tools (risk: 'read') can execute in parallel
 * - Non-concurrent tools (risk: 'write'/'execute') must execute alone
 * - Results are buffered and emitted in the order tools were received
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

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly context: AgentContext,
    private readonly eventSink?: AgentEventSink,
    private readonly runId = '',
    private readonly turn = 0,
    private readonly permissions?: {
      check: (tool: AgentTool, input: unknown, context: AgentContext) => Promise<'allow' | 'deny' | 'defer'>
    },
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
    const isConcurrencySafe = tool?.risk === 'read'

    this.tools.push({
      call,
      tool,
      status: 'queued',
      isConcurrencySafe,
      pendingProgress: [],
    })

    void this.processQueue()
  }

  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executingTools = this.tools.filter(t => t.status === 'executing')
    return (
      executingTools.length === 0 ||
      (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
    )
  }

  private async processQueue(): Promise<void> {
    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        await this.executeTool(tool)
      } else {
        if (!tool.isConcurrencySafe) break
      }
    }
  }

  private async executeTool(tracked: TrackedTool): Promise<void> {
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

      await this.emit({
        runId: this.runId,
        turn: this.turn,
        eventType: 'tool.started',
        summary: `Started ${tracked.call.name}`,
        status: 'started',
        toolCallId: tracked.call.id,
        data: { tool: tracked.call.name },
        timestamp: new Date().toISOString(),
      })

      try {
        // Check permissions
        if (this.permissions) {
          const decision = await this.permissions.check(tool, tracked.call.input, this.context)
          if (decision === 'defer') {
            this.context.goal.status = 'blocked'
            this.context.goal.remainingIssues = [`Awaiting user confirmation for ${tool.name}`]
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
          if (decision !== 'deny') {
            // 'allow' — proceed
          } else {
            messages.push({
              role: 'tool',
              toolCallId: tracked.call.id,
              content: `Permission denied: ${tool.name}`,
              isError: true,
            })
            tracked.results = messages
            tracked.status = 'completed'
            return
          }
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
            createdBy: tool.name,
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

        // Process result
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
          }
        }
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
        }
        if (result.goalUpdate) Object.assign(this.context.goal, result.goalUpdate)

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
    void promise.finally(() => {
      void this.processQueue()
    })
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

  private async emit(event: AgentActionEvent): Promise<void> {
    try {
      await this.eventSink?.emit(event)
    } catch {
      // Observability must never prevent the Agent from completing its work.
    }
  }
}
