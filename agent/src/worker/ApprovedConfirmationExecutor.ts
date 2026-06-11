import {
  type AgentTool,
  type AgentToolResult,
  ArtifactStore,
  type Diagnostic,
  type DomainState,
  DomainStateStore,
  executeToolCall,
  Transcript,
} from '@gsms/agent-core'
import type { TurnBoundary } from '../workflowBoundary.ts'
import { turnBoundaryAllowsTool } from '../workflowBoundary.ts'
import type {
  AgentSessionApiClient,
  PersistedAgentSession,
  PersistedConfirmation,
} from './AgentSessionApiClient.ts'

export interface ApprovedConfirmationExecutionInput {
  session: PersistedAgentSession
  confirmation: PersistedConfirmation
  tools: readonly AgentTool[]
  artifacts: ArtifactStore
  domainState: DomainStateStore
  workspace: string
  sessionApi: AgentSessionApiClient
}

export async function executeApprovedConfirmation(
  input: ApprovedConfirmationExecutionInput,
): Promise<string | undefined> {
  const { session, confirmation, tools, artifacts, domainState, workspace, sessionApi } = input
  const toolName = typeof confirmation.payload.tool === 'string' ? confirmation.payload.tool : ''
  const tool = tools.find(candidate => candidate.name === toolName)
  if (!tool) {
    throw new Error(`Approved confirmation references an unknown tool: ${toolName || '(missing)'}`)
  }
  if (tool.risk !== 'write' && tool.risk !== 'execute') {
    throw new Error(`Approved confirmation references a non-mutating tool: ${tool.name}`)
  }
  const toolInput = confirmation.payload.input
  const expectedAuthorizationKey = permissionAuthorizationKey(tool, toolInput, domainState.snapshot())
  const payloadAuthorizationKey = confirmation.payload.authorizationKey
  if (typeof payloadAuthorizationKey === 'string' && payloadAuthorizationKey !== expectedAuthorizationKey) {
    throw new Error(`Approved confirmation no longer matches current workflow state for ${tool.name}`)
  }

  const runId = createRunId()
  const toolCallId = `approved:${confirmation.id}:${tool.name}`
  const context = {
    workspace,
    goal: {
      objective: `Execute approved confirmation ${confirmation.id} for ${tool.name}`,
      status: 'active' as const,
      turnCount: 1,
      maxTurns: 1,
      evidence: [],
      remainingIssues: [],
      startedAt: new Date().toISOString(),
    },
    artifacts,
    domainState,
    lastConsumedConfirmationId: confirmation.id,
  }

  const transcript = new Transcript()
  const diagnostics: Diagnostic[] = []
  await sessionApi.appendEvent(session.id, 'run.started', {
    run_id: runId,
    turn: 0,
    summary: `Resuming approved confirmation for ${tool.name}`,
    status: 'started',
  })
  await sessionApi.consumeConfirmation(session.id, confirmation.id)

  try {
    const execution = await executeToolCall({
      tool,
      call: { id: toolCallId, name: tool.name, input: toolInput },
      context,
      runId,
      turn: 1,
      transcript,
      diagnostics,
      eventSink: {
        emit: event =>
          sessionApi.appendEvent(session.id, event.eventType, {
            run_id: event.runId,
            turn: event.turn,
            summary: event.summary,
            status: event.status,
            tool_call_id: event.toolCallId,
            duration_ms: event.durationMs,
            ...event.data,
          }).then(() => undefined),
      },
    })
    for (const message of execution.messages) {
      if (message.role === 'tool') transcript.record('tool_result', message)
      if (message.role === 'user' && message.hidden) transcript.record('message', message)
    }
    if (!execution.result || execution.messages.some(message => message.role === 'tool' && message.isError)) {
      const toolMessage = execution.messages.find(message => message.role === 'tool')
      throw new Error(toolMessage?.content || `${tool.name} failed during approved execution`)
    }
    const summary = approvedToolFinalSummary(tool, execution.result)
    const hiddenContinuations = execution.messages
      .filter(message => message.role === 'user' && message.hidden)
      .map(message => message.content.trim())
      .filter(Boolean)
    await sessionApi.appendEvent(session.id, 'run.completed', {
      run_id: runId,
      turn: 1,
      summary,
      status: 'completed',
      goalStatus: 'completed',
      diagnostics,
      transcript: transcript.events,
    })
    return [
      `Approved tool execution completed: ${summary}`,
      ...hiddenContinuations,
    ].join('\n\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await sessionApi.appendEvent(session.id, 'run.failed', {
      run_id: runId,
      turn: 1,
      summary: message,
      status: 'failed',
      goalStatus: 'failed',
      diagnostics,
      transcript: transcript.events,
    })
    await sessionApi.checkpoint(session.id, {
      action: 'fail',
      domain_state: domainState.snapshot(),
      artifacts: artifacts.list(undefined, { includeSuperseded: true }),
      assistant_message: `已确认执行 ${tool.name}，但工具执行失败：${message}`,
      error: message,
    })
    return undefined
  }
}

export function approvedConfirmationForDirectExecution(
  confirmations: readonly PersistedConfirmation[],
  tools: readonly AgentTool[],
  turnBoundary?: TurnBoundary,
): PersistedConfirmation | undefined {
  const writeToolNames = new Set(
    tools
      .filter(tool =>
        tool.policy?.confirmation?.approvedAction === 'execute-approved-input' &&
        (tool.risk === 'write' || tool.risk === 'execute'),
      )
      .filter(tool => !turnBoundary || turnBoundaryAllowsTool(turnBoundary, tool.name))
      .map(tool => tool.name),
  )
  return confirmations.find(confirmation =>
    confirmation.status === 'approved' &&
    typeof confirmation.payload.tool === 'string' &&
    writeToolNames.has(confirmation.payload.tool) &&
    Object.prototype.hasOwnProperty.call(confirmation.payload, 'input'),
  )
}

export function permissionAuthorizationKey(
  tool: AgentTool,
  input: unknown,
  state: DomainState,
): string {
  if (tool.name === 'write_invest_report') {
    return canonical({
      tool: tool.name,
      sceneId: state.sceneId,
      jobId: state.jobId,
    })
  }
  return canonical({ tool: tool.name, input })
}

export function approvedToolFinalSummary(tool: AgentTool, result: AgentToolResult): string {
  const policyMessage = tool.policy?.confirmation?.successMessage?.(result)
  if (policyMessage) return policyMessage
  return result.content || `${tool.name} completed after user approval.`
}

export function canonical(value: unknown): string {
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
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
