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
  | { type: 'notice'; level: 'warn' | 'stop'; text: string }

export type Turn = { role: 'user' | 'assistant'; blocks: TurnBlock[]; streaming?: boolean }

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
  } else if (ev.type === 'tool.completed' || ev.type === 'tool.failed') {
    if (INTERNAL_CONTROL_TOOLS.has(String(ev.data.tool))) return
    const id = ev.data.tool_call_id ?? ev.data.tool ?? 'unknown'
    const tb = blocks.find(b => b.type === 'tool' && b.id === id)
    if (tb && tb.type === 'tool') tb.status = ev.type === 'tool.completed' ? 'completed' : 'failed'
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
  }
}

/** Mark all of a run's blocks as settled (text done, running tools completed). */
export function finalizeBlocks(blocks: TurnBlock[]) {
  for (const b of blocks) {
    if (b.type === 'text' && b.status === 'streaming') b.status = 'done'
    if (b.type === 'tool' && b.status === 'running') b.status = 'completed'
  }
}
