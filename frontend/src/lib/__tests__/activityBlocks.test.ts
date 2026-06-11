import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEventToBlocks, buildTurnsFromMessagesAndRuns, finalizeBlocks, type TurnBlock } from '../activityBlocks.ts'
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
const toolDeferred = (tool: string, id = 0): AgentEvent => ({
  id, session_id: 's', type: 'tool.deferred', data: { run_id: 'run-1', tool, tool_call_id: tool, summary: 'Waiting for user confirmation' },
})
const confirmationRequested = (id = 0): AgentEvent => ({
  id,
  session_id: 's',
  type: 'confirmation.requested',
  data: {
    run_id: 'run-1',
    confirmation_id: 'c1',
    kind: 'import_data_hub_files_to_scene',
    prompt: 'Allow import?',
    payload: { input: { sceneId: 'scene-1', fileIds: ['f1'] } },
  },
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

test('deferred write tools settle instead of leaving a running activity block', () => {
  const blocks: TurnBlock[] = []
  applyEventToBlocks(blocks, toolStart('import_data_hub_files_to_scene'))
  applyEventToBlocks(blocks, toolDeferred('import_data_hub_files_to_scene'))
  applyEventToBlocks(blocks, confirmationRequested())

  assert.deepEqual(blocks[0], {
    type: 'tool',
    id: 'import_data_hub_files_to_scene',
    name: 'import_data_hub_files_to_scene',
    status: 'completed',
    message: 'Waiting for user confirmation',
  })
  assert.deepEqual(blocks[1], {
    type: 'confirmation',
    id: 'c1',
    kind: 'import_data_hub_files_to_scene',
    status: 'pending',
    prompt: 'Allow import?',
    payload: { input: { sceneId: 'scene-1', fileIds: ['f1'] } },
  })
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

test('paused confirmation run does not consume the next assistant message slot', () => {
  const pausedBlocks: TurnBlock[] = [
    { type: 'tool', id: 'import', name: 'import_data_hub_files_to_scene', status: 'completed', message: 'Waiting for user confirmation' },
    { type: 'confirmation', id: 'c1', kind: 'import_data_hub_files_to_scene', status: 'consumed' },
  ]
  const answerBlocks: TurnBlock[] = [
    { type: 'text', text: 'Continuing after approval.', status: 'done' },
  ]
  const runBlocks = new Map<string, TurnBlock[]>([
    ['run-paused', pausedBlocks],
    ['run-answer', answerBlocks],
  ])
  const runStatuses = new Map([
    ['run-paused', 'paused' as const],
    ['run-answer', 'completed' as const],
  ])

  const whilePending = buildTurnsFromMessagesAndRuns({
    messages: [{ role: 'user', content: 'Can Carbon run?' }],
    runOrder: ['run-paused'],
    runBlocks,
    runStatuses,
    pendingConfirmation: true,
  })
  assert.equal(whilePending.length, 2, 'pending confirmation shows a separate waiting activity card')
  assert.equal(whilePending[1]!.streaming, true, 'waiting activity card has no final answer block')
  assert.equal(whilePending[1]!.blocks[0]!.type, 'tool')

  const afterApproval = buildTurnsFromMessagesAndRuns({
    messages: [
      { role: 'user', content: 'Can Carbon run?' },
      { role: 'assistant', content: 'Carbon can now be assessed from imported data.' },
    ],
    runOrder: ['run-paused', 'run-answer'],
    runBlocks,
    runStatuses,
    pendingConfirmation: false,
  })

  assert.equal(afterApproval.length, 2, 'after approval the paused confirmation history is merged into the answer turn')
  assert.equal(afterApproval[1]!.blocks[0]!.type, 'tool')
  assert.equal(afterApproval[1]!.blocks[1]!.type, 'confirmation')
  assert.deepEqual(textOf(afterApproval[1]!.blocks), [
    'Continuing after approval.',
    'Carbon can now be assessed from imported data.',
  ])
})

test('completed assistant answer keeps its thinking activity blocks', () => {
  const runBlocks = new Map<string, TurnBlock[]>([
    ['run-answer', [
      { type: 'text', text: 'I will inspect data.', status: 'done' },
      { type: 'tool', id: 'cards', name: 'list_scene_data_cards', status: 'completed' },
    ]],
  ])
  const turns = buildTurnsFromMessagesAndRuns({
    messages: [
      { role: 'user', content: 'Can Carbon run?' },
      { role: 'assistant', content: 'Carbon has enough imported data.' },
    ],
    runOrder: ['run-answer'],
    runBlocks,
    runStatuses: new Map([['run-answer', 'completed' as const]]),
    pendingConfirmation: false,
  })

  assert.equal(turns.length, 2)
  assert.equal(turns[1]!.blocks.length, 3)
  assert.equal(turns[1]!.blocks[0]!.type, 'text')
  assert.equal(turns[1]!.blocks[1]!.type, 'tool')
  assert.equal(turns[1]!.blocks[2]!.type, 'text')
})

test('completed tool-only run does not consume the next assistant message slot', () => {
  const runBlocks = new Map<string, TurnBlock[]>([
    ['run-approved-tool', [
      { type: 'tool', id: 'approved:c1:import_data_hub_files_to_scene', name: 'import_data_hub_files_to_scene', status: 'completed' },
      { type: 'confirmation', id: 'c1', kind: 'import_data_hub_files_to_scene', status: 'consumed' },
    ]],
    ['run-answer', [
      { type: 'text', text: 'Rechecking imported data.', status: 'done' },
    ]],
  ])
  const turns = buildTurnsFromMessagesAndRuns({
    messages: [
      { role: 'user', content: 'Can Carbon run?' },
      { role: 'assistant', content: 'Carbon can now be assessed from imported data.' },
    ],
    runOrder: ['run-approved-tool', 'run-answer'],
    runBlocks,
    runStatuses: new Map([
      ['run-approved-tool', 'completed' as const],
      ['run-answer', 'completed' as const],
    ]),
    pendingConfirmation: false,
  })

  assert.equal(turns.length, 2, 'tool-only approved run is merged into the later assistant answer')
  assert.equal(turns[1]!.blocks[0]!.type, 'tool')
  assert.equal(turns[1]!.blocks[2]!.type, 'text')
})

test('confirmation-gated discovery and continuation render as one assistant turn', () => {
  const runBlocks = new Map<string, TurnBlock[]>([
    ['run-discovery', [
      { type: 'text', text: 'Searching Data Hub for Carbon inputs.', status: 'done' },
      { type: 'tool', id: 'discover', name: 'discover_data_hub_candidates', status: 'completed' },
      { type: 'text', text: 'Found recommended imports.', status: 'done' },
      { type: 'tool', id: 'import', name: 'import_data_hub_files_to_scene', status: 'completed', message: 'Waiting for user confirmation' },
      {
        type: 'confirmation',
        id: 'c1',
        kind: 'import_data_hub_files_to_scene',
        status: 'consumed',
        prompt: 'Import recommended files?',
        payload: { input: { sceneId: 'scene-1', fileIds: ['lulc', 'carbon'] } },
      },
    ]],
    ['run-approved-import', [
      { type: 'tool', id: 'approved:c1:import_data_hub_files_to_scene', name: 'import_data_hub_files_to_scene', status: 'completed' },
    ]],
    ['run-continuation', [
      { type: 'text', text: 'Rechecking scene data after import.', status: 'done' },
      { type: 'tool', id: 'required', name: 'retrieve_required_input_candidates', status: 'completed' },
    ]],
  ])

  const liveTurns = buildTurnsFromMessagesAndRuns({
    messages: [{ role: 'user', content: 'Can Carbon run?' }],
    runOrder: ['run-discovery', 'run-approved-import', 'run-continuation'],
    runBlocks,
    runStatuses: new Map([
      ['run-discovery', 'paused' as const],
      ['run-approved-import', 'completed' as const],
      ['run-continuation', 'active' as const],
    ]),
    pendingConfirmation: false,
  })
  assert.equal(liveTurns.length, 2, 'continuation before final answer stays in one live assistant turn')
  assert.equal(liveTurns[1]!.streaming, true)
  assert.equal(liveTurns[1]!.blocks.filter(block => block.type === 'confirmation').length, 1)
  assert.deepEqual(textOf(liveTurns[1]!.blocks), [
    'Searching Data Hub for Carbon inputs.',
    'Found recommended imports.',
    'Rechecking scene data after import.',
  ])

  const completedTurns = buildTurnsFromMessagesAndRuns({
    messages: [
      { role: 'user', content: 'Can Carbon run?' },
      { role: 'assistant', content: 'Carbon can run with the imported files.' },
    ],
    runOrder: ['run-discovery', 'run-approved-import', 'run-continuation'],
    runBlocks,
    runStatuses: new Map([
      ['run-discovery', 'paused' as const],
      ['run-approved-import', 'completed' as const],
      ['run-continuation', 'completed' as const],
    ]),
    pendingConfirmation: false,
  })

  assert.equal(completedTurns.length, 2, 'final answer uses the same assistant turn, avoiding an extra AI avatar')
  assert.equal(completedTurns[1]!.blocks.filter(block => block.type === 'confirmation').length, 1)
  assert.deepEqual(textOf(completedTurns[1]!.blocks), [
    'Searching Data Hub for Carbon inputs.',
    'Found recommended imports.',
    'Rechecking scene data after import.',
    'Carbon can run with the imported files.',
  ])
})
