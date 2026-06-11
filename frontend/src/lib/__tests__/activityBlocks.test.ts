import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEventToBlocks, finalizeBlocks, type TurnBlock } from '../activityBlocks.ts'
import type { AgentEvent } from '../repos/agentSessionsRepo.ts'

// Build a model.streaming text-delta event (one provider token per event — that's
// how the backend persists them: agent_events rows of length 1-11 chars).
const tok = (text: string, id = 0): AgentEvent => ({
  id, session_id: 's', type: 'model.streaming', data: { run_id: 'run-1', text },
})
const toolStart = (tool: string, id = 0): AgentEvent => ({
  id, session_id: 's', type: 'model.streaming', data: { run_id: 'run-1', tool, tool_call_id: tool },
})
const toolDone = (tool: string, id = 0): AgentEvent => ({
  id, session_id: 's', type: 'tool.completed', data: { run_id: 'run-1', tool, tool_call_id: tool },
})

const textOf = (blocks: TurnBlock[]) =>
  blocks.filter((b): b is Extract<TurnBlock, { type: 'text' }> => b.type === 'text').map(b => b.text)

test('consecutive text tokens coalesce into one block', () => {
  const blocks: TurnBlock[] = []
  for (const t of ['Hab', 'itat', ' Quality', ' model']) applyEventToBlocks(blocks, tok(t))
  assert.deepEqual(textOf(blocks), ['Habitat Quality model'])
})

test('a tool call between text runs starts a new text block (segment boundary)', () => {
  const blocks: TurnBlock[] = []
  applyEventToBlocks(blocks, tok('Now'))
  applyEventToBlocks(blocks, tok(' I'))
  applyEventToBlocks(blocks, toolStart('get_invest_model_schema'))
  applyEventToBlocks(blocks, toolDone('get_invest_model_schema'))
  applyEventToBlocks(blocks, tok('Hab'))
  applyEventToBlocks(blocks, tok('itat'))
  assert.deepEqual(textOf(blocks), ['Now I', 'Habitat'])
})

test('internal control tools do not render as activity cards', () => {
  const blocks: TurnBlock[] = []
  applyEventToBlocks(blocks, tok('Two'))
  applyEventToBlocks(blocks, toolStart('finish'))
  applyEventToBlocks(blocks, toolDone('finish'))
  applyEventToBlocks(blocks, toolStart('update_goal'))
  applyEventToBlocks(blocks, toolDone('update_goal'))

  assert.deepEqual(blocks, [{ type: 'text', text: 'Two', status: 'streaming' }])
})

// The regression this fixes: under the polling fallback, a batch can carry the
// run's just-persisted assistant message AND that run's still-arriving tokens, so
// rebuildTurns() runs finalizeBlocks() on the run (marking its text 'done')
// BEFORE the trailing tokens are folded. Before the fix, every trailing token
// then spawned its own one-token block → "两个字一行".
test('tokens after finalizeBlocks still coalesce (polling-batch regression)', () => {
  const blocks: TurnBlock[] = []
  for (const t of ['The', ' carbon']) applyEventToBlocks(blocks, tok(t))

  // A rebuild finalized the run mid-stream (run looked non-live for one tick).
  finalizeBlocks(blocks)
  assert.equal(blocks[0].type === 'text' && blocks[0].status, 'done')

  // Trailing tokens of the SAME text run keep arriving.
  for (const t of [' storage', ' model']) applyEventToBlocks(blocks, tok(t))

  assert.deepEqual(textOf(blocks), ['The carbon storage model'])
  assert.equal(blocks.length, 1, 'must remain a single text block, not one block per token')
  // Re-opened to streaming because more text arrived after the premature finalize.
  assert.equal(blocks[0].type === 'text' && blocks[0].status, 'streaming')
})

// The core guarantee: feeding the identical event list one-at-a-time (SSE) and
// then all-at-once with an interleaved finalize (polling) yields the same text.
test('SSE folding and polling folding produce identical text blocks', () => {
  const events: AgentEvent[] = [
    tok('Let', 1), tok(' me', 2), tok(' retrieve', 3),
    toolStart('list_invest_models', 4), toolDone('list_invest_models', 5),
    tok('Three', 6), tok(' models', 7), tok(' found', 8), tok('.', 9),
  ]

  // SSE: fold one event per frame, no batched finalize.
  const sse: TurnBlock[] = []
  for (const ev of events) applyEventToBlocks(sse, ev)

  // Polling: fold in two batches, with a finalize between them (the run briefly
  // looked settled when its assistant message landed in the first batch).
  const poll: TurnBlock[] = []
  for (const ev of events.slice(0, 6)) applyEventToBlocks(poll, ev)
  finalizeBlocks(poll)
  for (const ev of events.slice(6)) applyEventToBlocks(poll, ev)

  assert.deepEqual(textOf(poll), textOf(sse))
  assert.deepEqual(textOf(sse), ['Let me retrieve', 'Three models found.'])
})
