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
import type { Transcript } from '../transcript/Transcript.ts'

export interface ToolExecutionHostOptions {
  context: AgentContext
  eventSink?: AgentEventSink
  runId: string
  turn: number
  transcript?: Transcript
  diagnostics?: Diagnostic[]
}

export interface ExecuteToolCallOptions extends ToolExecutionHostOptions {
  tool: AgentTool
  call: ToolCall
  guard?: {
    check: (tool: AgentTool, input: unknown, context: AgentContext) => Promise<'allow' | 'deny' | 'defer'>
  }
  onProgressMessage?: (message: AgentMessage) => void
}

export interface ExecuteToolCallResult {
  messages: AgentMessage[]
  result?: AgentToolResult
  deferred: boolean
  outcome: 'completed' | 'deferred' | 'denied' | 'failed'
}

export async function executeToolCall(options: ExecuteToolCallOptions): Promise<ExecuteToolCallResult> {
  const { tool, call, context, runId, turn, guard } = options
  const messages: AgentMessage[] = []
  const startedAt = Date.now()

  options.transcript?.record('tool_call', call)
  await emit(options.eventSink, {
    runId,
    turn,
    eventType: 'tool.started',
    summary: `Started ${call.name}`,
    status: 'started',
    toolCallId: call.id,
    data: { tool: call.name, input: sanitizeForEvent(call.input) },
    timestamp: new Date().toISOString(),
  })

  try {
    if (guard) {
      const decision = await guard.check(tool, call.input, context)
      if (decision === 'defer') {
        context.goal.status = 'blocked'
        context.goal.remainingIssues = [`Awaiting user confirmation for ${tool.name}`]
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `Permission deferred pending user confirmation: ${tool.name}`,
          isError: true,
        })
        await emit(options.eventSink, {
          runId,
          turn,
          eventType: 'tool.deferred',
          summary: `Waiting for user confirmation before ${tool.name}`,
          status: 'waiting',
          toolCallId: call.id,
          data: { tool: tool.name },
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        })
        return { messages, deferred: true, outcome: 'deferred' }
      }
      if (decision === 'deny') {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `Tool not available: ${tool.name} is not permitted in the current workflow phase or skill scope.`,
          isError: true,
        })
        await emit(options.eventSink, {
          runId,
          turn,
          eventType: 'tool.failed',
          summary: `Denied ${call.name} - not visible in current scope`,
          status: 'failed',
          toolCallId: call.id,
          data: { tool: tool.name, reason: 'visibility_denied' },
          durationMs: Date.now() - startedAt,
          timestamp: new Date().toISOString(),
        })
        return { messages, deferred: false, outcome: 'denied' }
      }
    }

    const onProgress = (event: ToolProgressEvent) => {
      options.onProgressMessage?.({
        role: 'user',
        content: event.message,
        hidden: true,
      })
      void emit(options.eventSink, {
        runId,
        turn,
        eventType: 'tool.progress',
        summary: event.message,
        status: 'completed',
        toolCallId: call.id,
        data: { message: event.message, percentage: event.percentage },
        timestamp: new Date().toISOString(),
      })
    }
    const result = await tool.execute(call.input, context, onProgress)
    const content = await applyToolResult({
      ...options,
      tool,
      call,
      result,
    })
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      content,
      isError: false,
    })
    await emit(options.eventSink, {
      runId,
      turn,
      eventType: 'tool.completed',
      summary: `Completed ${call.name}`,
      status: 'completed',
      toolCallId: call.id,
      data: { tool: call.name },
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    })
    if (result.hiddenMessages?.length) messages.push(...result.hiddenMessages)
    return { messages, result, deferred: false, outcome: 'completed' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: message,
      isError: true,
    })
    await emit(options.eventSink, {
      runId,
      turn,
      eventType: 'tool.failed',
      summary: `Failed ${call.name}: ${message.slice(0, 200)}`,
      status: 'failed',
      toolCallId: call.id,
      data: { tool: call.name, error: message.slice(0, 200) },
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    })
    return { messages, deferred: false, outcome: 'failed' }
  }
}

export async function applyToolResult(options: ToolExecutionHostOptions & {
  tool: AgentTool
  call: ToolCall
  result: AgentToolResult
}): Promise<string> {
  const { context, tool, call, result, runId, turn } = options

  if (tool.persistResultAboveBytes && result.content.length > tool.persistResultAboveBytes) {
    const inputKey = JSON.stringify(call.input).slice(0, 120)
    const persisted = context.artifacts.create({
      type: 'tool-result',
      logicalKey: `tool-result:${tool.name}:${inputKey}`,
      createdBy: 'tool',
      metadata: { inputKey },
      data: { tool: tool.name, input: call.input, fullContent: result.content },
    })
    await emit(options.eventSink, {
      runId,
      turn,
      eventType: 'artifact.created',
      summary: `Persisted large output from ${tool.name} (${result.content.length} chars)`,
      status: 'completed',
      data: { artifactId: persisted.id, artifactType: 'tool-result' },
      timestamp: new Date().toISOString(),
    })
    const length = result.content.length
    const truncated = result.content.slice(0, 500)
    result.content = `${truncated}\n\n[Full result persisted as artifact "${persisted.id}" (${length} chars). Use get_artifact to retrieve if needed.]`
  }

  if (result.artifacts?.length) {
    for (const artifact of result.artifacts) {
      if (artifact.createdBy === 'user') {
        const isWriteOrExecute = tool.risk === 'write' || tool.risk === 'execute'
        const hasConfirmationBinding =
          isWriteOrExecute &&
          typeof artifact.metadata?.confirmationId === 'string' &&
          artifact.metadata.confirmationId.length > 0
        if (!hasConfirmationBinding) {
          artifact.createdBy = 'tool'
        }
      }
    }
    const created = context.artifacts.createMany(result.artifacts)
    for (const artifact of created) {
      await emit(options.eventSink, {
        runId,
        turn,
        eventType: 'artifact.created',
        summary: `Created ${artifact.type} artifact`,
        status: 'completed',
        data: { artifactId: artifact.id, artifactType: artifact.type },
        timestamp: new Date().toISOString(),
      })
      options.transcript?.record('artifact', {
        action: 'created',
        id: artifact.id,
        type: artifact.type,
      })
    }
  }

  if (result.statePatch) {
    const state = context.domainState.applyPatch(result.statePatch)
    await emit(options.eventSink, {
      runId,
      turn,
      eventType: 'state.changed',
      summary: `Updated workflow state${typeof state.phase === 'string' ? ` to ${state.phase}` : ''}`,
      status: 'completed',
      data: { patch: result.statePatch },
      timestamp: new Date().toISOString(),
    })
    options.transcript?.record('state', {
      action: 'patched',
      patch: result.statePatch,
    })
  }

  if (result.goalUpdate) Object.assign(context.goal, result.goalUpdate)

  if (result.activateSkill) {
    context.skillScope = {
      name: result.activateSkill.name,
      allowedTools: new Set(result.activateSkill.allowedTools),
      activatedAtTurn: turn,
    }
    await emit(options.eventSink, {
      runId,
      turn,
      eventType: 'state.changed',
      summary: `Activated skill "${result.activateSkill.name}" with ${result.activateSkill.allowedTools.length} allowed tools`,
      status: 'completed',
      data: { skill: result.activateSkill.name, allowedTools: result.activateSkill.allowedTools },
      timestamp: new Date().toISOString(),
    })
  }

  if (result.diagnostics?.length) {
    options.diagnostics?.push(...result.diagnostics)
    for (const diag of result.diagnostics) {
      options.transcript?.record('diagnostic', diag)
      await emit(options.eventSink, {
        runId,
        turn,
        eventType: 'diagnostic.created',
        summary: diag.message,
        status: diag.severity === 'error' ? 'failed' : 'completed',
        data: { code: diag.code, severity: diag.severity },
        timestamp: new Date().toISOString(),
      })
    }
  }

  return result.content
}

async function emit(eventSink: AgentEventSink | undefined, event: AgentActionEvent): Promise<void> {
  try {
    await eventSink?.emit(event)
  } catch {
    // Observability must never prevent the Agent from completing its work.
  }
}

function summarizeText(value: string, maxLength = 1000): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact
}

export function sanitizeForEvent(value: unknown, depth = 0): unknown {
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
