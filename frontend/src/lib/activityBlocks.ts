import type { AgentEvent } from './repos/agentSessionsRepo'

/**
 * Activity-block folding: the pure projection from the agent event stream to the
 * "think card" timeline blocks. Extracted from the workbench page so it can be
 * unit-tested (and reused by the planned Vue front end) without React.
 *
 * Invariant under test: SSE (one event per frame) and the polling fallback
 * (events fetched in batches) must produce IDENTICAL blocks. The streaming text
 * deltas are one provider token each (1-11 chars); they only read as a coherent
 * paragraph if consecutive tokens coalesce into a single text block.
 */

export type TurnBlock =
  | { type: 'text'; text: string; status: 'streaming' | 'done' }
  | { type: 'tool'; id: string; name: string; status: 'running' | 'completed' | 'failed'; message?: string; percentage?: number; archived?: boolean }
  | { type: 'confirmation'; id: string; kind: string; status: 'pending' | 'approved' | 'rejected' | 'consumed'; prompt?: string; payload?: Record<string, unknown> }
  | { type: 'notice'; level: 'warn' | 'stop'; text: string }

export type Turn = { role: 'user' | 'assistant'; blocks: TurnBlock[]; streaming?: boolean }
export type MessageLike = { role: 'user' | 'assistant'; content: string }
export type RunStatus = 'active' | 'paused' | 'completed' | 'failed'

const INTERNAL_CONTROL_TOOLS = new Set(['finish', 'update_goal'])

/** Apply one streaming/tool event to a run's accumulating activity blocks (mutates in place). */
export function applyEventToBlocks(blocks: TurnBlock[], ev: AgentEvent) {
  if (ev.type === 'model.streaming') {
    if (ev.data.text) {
      // Each streaming event is one provider token (1-11 chars). Consecutive
      // tokens MUST coalesce into a single text block, otherwise the thinking
      // timeline renders one token per line ("两个字一行").
      //
      // The merge condition is block ADJACENCY, not display status: append to the
      // last block whenever it is a text block, even if a prior finalizeBlocks()
      // already marked it 'done'. The polling fallback batches events, so it can
      // observe a run's assistant message (→ run no longer "live" → finalize)
      // interleaved with that run's still-arriving tokens; if 'done' blocked the
      // append, every later token would spawn its own line. A fresh token means
      // the run is still emitting text, so re-open the block.
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'text') {
        last.text += ev.data.text
        last.status = 'streaming'
      } else {
        blocks.push({ type: 'text', text: ev.data.text, status: 'streaming' })
      }
    } else if (ev.data.tool) {
      if (INTERNAL_CONTROL_TOOLS.has(String(ev.data.tool))) return
      const id = ev.data.tool_call_id ?? ev.data.tool
      if (!blocks.some(b => b.type === 'tool' && b.id === id)) {
        blocks.push({ type: 'tool', id, name: ev.data.tool, status: 'running' })
      }
    }
  } else if (ev.type === 'tool.started') {
    if (INTERNAL_CONTROL_TOOLS.has(String(ev.data.tool))) return
    const id = ev.data.tool_call_id ?? ev.data.tool ?? 'unknown'
    if (!blocks.some(b => b.type === 'tool' && b.id === id)) {
      blocks.push({ type: 'tool', id, name: ev.data.tool ?? 'tool', status: 'running' })
    }
  } else if (ev.type === 'tool.progress') {
    if (INTERNAL_CONTROL_TOOLS.has(String(ev.data.tool))) return
    const id = ev.data.tool_call_id ?? ev.data.tool ?? 'unknown'
    const tb = blocks.find(b => b.type === 'tool' && b.id === id)
    if (tb && tb.type === 'tool') { tb.message = ev.data.message; tb.percentage = ev.data.percentage }
  } else if (ev.type === 'tool.completed' || ev.type === 'tool.failed' || ev.type === 'tool.deferred') {
    if (INTERNAL_CONTROL_TOOLS.has(String(ev.data.tool))) return
    const id = ev.data.tool_call_id ?? ev.data.tool ?? 'unknown'
    const tb = blocks.find(b => b.type === 'tool' && b.id === id)
    if (tb && tb.type === 'tool') {
      tb.status = ev.type === 'tool.failed' ? 'failed' : 'completed'
      if (ev.type === 'tool.deferred') tb.message = ev.data.summary ?? '等待用户确认'
    }
  } else if (ev.type === 'artifact.created' && ev.data.artifactType === 'tool-result') {
    // Large tool output was persisted as an artifact. The artifactId encodes the
    // tool name as `tool-result:<toolName>:<input>`; flag the matching block.
    const artifactId = typeof ev.data.artifactId === 'string' ? ev.data.artifactId : ''
    const toolName = artifactId.split(':')[1]
    if (toolName) {
      const tb = [...blocks].reverse().find(b => b.type === 'tool' && b.name === toolName)
      if (tb && tb.type === 'tool') tb.archived = true
    }
  } else if (ev.type === 'diagnostic.created') {
    const code = typeof ev.data.code === 'string' ? ev.data.code : ''
    if (code === 'AGENT_NO_PROGRESS') {
      blocks.push({ type: 'notice', level: 'stop', text: '智能体连续多轮未产生新证据，已自动停止以避免空转。' })
    }
  } else if (ev.type === 'confirmation.requested') {
    const id = String(ev.data.confirmation_id ?? 'confirmation')
    if (!blocks.some(b => b.type === 'confirmation' && b.id === id)) {
      blocks.push({
        type: 'confirmation',
        id,
        kind: String(ev.data.kind ?? 'confirmation'),
        status: 'pending',
        prompt: typeof ev.data.prompt === 'string' ? ev.data.prompt : undefined,
        payload: ev.data.payload && typeof ev.data.payload === 'object'
          ? ev.data.payload as Record<string, unknown>
          : undefined,
      })
    }
  } else if (ev.type === 'confirmation.resolved') {
    const id = String(ev.data.confirmation_id ?? 'confirmation')
    const block = blocks.find(b => b.type === 'confirmation' && b.id === id)
    if (block && block.type === 'confirmation') {
      const status = String(ev.data.status ?? '')
      if (status === 'approved' || status === 'rejected' || status === 'consumed') block.status = status
    } else {
      const status = String(ev.data.status ?? '') === 'rejected' ? 'rejected' : 'approved'
      blocks.push({ type: 'confirmation', id, kind: 'confirmation', status })
    }
  } else if (ev.type === 'confirmation.consumed') {
    const id = String(ev.data.confirmation_id ?? 'confirmation')
    const block = blocks.find(b => b.type === 'confirmation' && b.id === id)
    if (block && block.type === 'confirmation') block.status = 'consumed'
  } else if (ev.type === 'run.paused' || ev.type === 'run.completed' || ev.type === 'run.failed') {
    finalizeBlocks(blocks)
  }
}

/** Mark all of a run's blocks as settled (text done, running tools completed). */
export function finalizeBlocks(blocks: TurnBlock[]) {
  for (const b of blocks) {
    if (b.type === 'text' && b.status === 'streaming') b.status = 'done'
    if (b.type === 'tool' && b.status === 'running') b.status = 'completed'
  }
}

export function buildTurnsFromMessagesAndRuns(input: {
  messages: readonly MessageLike[]
  runOrder: readonly string[]
  runBlocks: ReadonlyMap<string, readonly TurnBlock[]>
  runStatuses: ReadonlyMap<string, RunStatus>
  pendingConfirmation: boolean
}): Turn[] {
  const answerRunOrder = input.runOrder.filter(runId => runProducesAssistantAnswer(runId, input.runBlocks, input.runStatuses))
  const assistantCount = input.messages.filter(m => m.role === 'assistant').length
  const hasLiveRun = answerRunOrder.length > assistantCount

  let mapped = 0
  for (const runId of input.runOrder) {
    const isAnswerRun = runProducesAssistantAnswer(runId, input.runBlocks, input.runStatuses)
    const isLive = isAnswerRun && hasLiveRun && mapped >= assistantCount
    if (!isLive) {
      const blocks = input.runBlocks.get(runId) as TurnBlock[] | undefined
      if (blocks) finalizeBlocks(blocks)
    }
    if (isAnswerRun) mapped++
  }

  let assistantSeen = 0
  const turns: Turn[] = []
  const consumedRuns = new Set<string>()
  const answerRunIds = new Set(answerRunOrder)
  const collectToolOnlyRunsBefore = (targetRunId: string | undefined): TurnBlock[] => {
    const collected: TurnBlock[] = []
    for (const runId of input.runOrder) {
      if (runId === targetRunId) return collected
      if (consumedRuns.has(runId) || answerRunIds.has(runId)) continue
      const blocks = input.runBlocks.get(runId)
      if (blocks?.length) {
        collected.push(...blocks.map(b => ({ ...b })))
      }
      consumedRuns.add(runId)
    }
    return collected
  }

  for (const msg of input.messages) {
    if (msg.role !== 'assistant') {
      turns.push({ role: 'user', blocks: [{ type: 'text', text: msg.content, status: 'done' }] })
      continue
    }
    const runId = answerRunOrder[assistantSeen]
    const prefixActivity = collectToolOnlyRunsBefore(runId)
    assistantSeen++
    const activity = (runId && input.runBlocks.get(runId)) || []
    if (runId) consumedRuns.add(runId)
    turns.push({
      role: 'assistant',
      blocks: [
        ...prefixActivity,
        ...activity.map(b => ({ ...b })),
        { type: 'text', text: msg.content, status: 'done' },
      ],
    })
  }

  if (hasLiveRun) {
    const liveRunId = answerRunOrder[assistantSeen]
    const prefixActivity = collectToolOnlyRunsBefore(liveRunId)
    const liveBlocks = input.runBlocks.get(liveRunId)
    const blocks = [
      ...prefixActivity,
      ...(liveBlocks?.map(b => ({ ...b })) ?? []),
    ]
    if (blocks.length) {
      turns.push({ role: 'assistant', blocks, streaming: true })
      consumedRuns.add(liveRunId)
    }
  } else if (input.pendingConfirmation) {
    const pausedRunId = [...input.runOrder].reverse().find(runId => input.runStatuses.get(runId) === 'paused')
    const pausedBlocks = pausedRunId ? input.runBlocks.get(pausedRunId) : undefined
    if (pausedBlocks?.length && pausedRunId && !consumedRuns.has(pausedRunId)) {
      turns.push({ role: 'assistant', blocks: pausedBlocks.map(b => ({ ...b })), streaming: true })
      consumedRuns.add(pausedRunId)
    }
  }
  const orphanRunIds = input.runOrder.filter(runId =>
    !consumedRuns.has(runId) &&
    !answerRunIds.has(runId) &&
    (input.runStatuses.get(runId) === 'active' || input.runBlocks.get(runId)?.length),
  )
  const orphanBlocks: TurnBlock[] = []
  let orphanStreaming = false
  for (const runId of orphanRunIds) {
    const blocks = input.runBlocks.get(runId)
    if (blocks?.length) {
      orphanBlocks.push(...blocks.map(b => ({ ...b })))
      orphanStreaming ||= input.runStatuses.get(runId) === 'active' || hasPendingConfirmation(blocks)
    }
  }
  if (orphanBlocks.length) {
    turns.push({ role: 'assistant', blocks: orphanBlocks, streaming: orphanStreaming })
  }

  return turns
}

function runProducesAssistantAnswer(
  runId: string,
  runBlocks: ReadonlyMap<string, readonly TurnBlock[]>,
  runStatuses: ReadonlyMap<string, RunStatus>,
): boolean {
  if (runStatuses.get(runId) === 'paused') return false
  const blocks = runBlocks.get(runId) ?? []
  if (blocks.some(block => block.type === 'confirmation')) return false
  return blocks.some(block => block.type === 'text')
}

function hasPendingConfirmation(blocks: readonly TurnBlock[]): boolean {
  return blocks.some(block => block.type === 'confirmation' && block.status === 'pending')
}
