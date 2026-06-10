import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentTool, AgentContext, ModelAdapter, ModelResponse } from '@gsms/agent-core'
import { ArtifactStore, DomainStateStore, ToolRegistry } from '@gsms/agent-core'
import { createReconTool } from '../src/tools/reconTools.ts'
import { buildTool } from '../src/tools/buildTool.ts'

function makeContext(): AgentContext {
  return {
    workspace: '/tmp/test',
    goal: {
      objective: 'test',
      status: 'active',
      turnCount: 0,
      maxTurns: 10,
      evidence: [],
      remainingIssues: [],
      startedAt: '2026-01-01T00:00:00.000Z',
    },
    artifacts: new ArtifactStore(),
    domainState: new DomainStateStore(),
  }
}

test('run_reconnaissance is a read-only tool', () => {
  const model: ModelAdapter = { async complete() { return { content: 'ok' } } }
  const tool = createReconTool([], () => model)
  assert.equal(tool.risk, 'read')
  assert.equal(tool.name, 'run_reconnaissance')
  assert.ok(tool.description.includes('read-only'))
})

test('run_reconnaissance has correct input schema', () => {
  const model: ModelAdapter = { async complete() { return { content: 'ok' } } }
  const tool = createReconTool([], () => model)
  const props = tool.inputSchema.properties as Record<string, unknown>
  assert.ok(props.prompt, 'has prompt property')
  assert.ok(props.allowedTools, 'has allowedTools property')
  assert.ok(props.maxTurns, 'has maxTurns property')
})

test('run_reconnaissance limits tools to read-only', async () => {
  const readTool = buildTool({
    name: 'safe_read',
    description: 'safe',
    inputSchema: {},
    async execute() { return { content: 'ok' } },
  })
  const writeTool = buildTool({
    name: 'dangerous_write',
    description: 'dangerous',
    risk: 'write',
    inputSchema: {},
    async execute() { return { content: 'ok' } },
  })

  let capturedTools: string[] = []
  const spyModel: ModelAdapter = {
    async complete(request) {
      capturedTools = request.tools.map(t => t.name)
      // Immediately finish to avoid looping
      return {
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'finish', input: { summary: 'done' } }],
      }
    },
  }

  const reconTool = createReconTool([readTool, writeTool], () => spyModel)
  const ctx = makeContext()
  await reconTool.execute({ prompt: 'test' }, ctx)

  assert.ok(capturedTools.includes('safe_read'), 'read tool is available')
  assert.ok(!capturedTools.includes('dangerous_write'), 'write tool is filtered out')
  assert.ok(capturedTools.includes('finish'), 'finish tool is always available')
})

test('run_reconnaissance respects allowedTools filter', async () => {
  const toolA = buildTool({
    name: 'tool_a',
    description: 'a',
    inputSchema: {},
    async execute() { return { content: 'a' } },
  })
  const toolB = buildTool({
    name: 'tool_b',
    description: 'b',
    inputSchema: {},
    async execute() { return { content: 'b' } },
  })

  let capturedTools: string[] = []
  const spyModel: ModelAdapter = {
    async complete(request) {
      capturedTools = request.tools.map(t => t.name)
      return {
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'finish', input: { summary: 'done' } }],
      }
    },
  }

  const reconTool = createReconTool([toolA, toolB], () => spyModel)
  const ctx = makeContext()
  await reconTool.execute({ prompt: 'test', allowedTools: ['tool_a'] }, ctx)

  assert.ok(capturedTools.includes('tool_a'), 'tool_a is available')
  assert.ok(!capturedTools.includes('tool_b'), 'tool_b is filtered by allowedTools')
})

test('run_reconnaissance returns error when no matching tools', async () => {
  const readTool = buildTool({
    name: 'safe_read',
    description: 'safe',
    inputSchema: {},
    async execute() { return { content: 'ok' } },
  })

  const model: ModelAdapter = { async complete() { return { content: 'ok' } } }
  const reconTool = createReconTool([readTool], () => model)
  const ctx = makeContext()

  const result = await reconTool.execute(
    { prompt: 'test', allowedTools: ['nonexistent_tool'] },
    ctx,
  )

  const parsed = JSON.parse(result.content)
  assert.ok(parsed.error, 'returns error')
  assert.ok(parsed.error.includes('No matching read-only tools'))
})

test('run_reconnaissance passes maxTurns to subagent', async () => {
  const readTool = buildTool({
    name: 'read_tool',
    description: 'read',
    inputSchema: {},
    async execute() { return { content: 'data' } },
  })

  let turnCount = 0
  const countingModel: ModelAdapter = {
    async complete() {
      turnCount++
      return {
        content: '',
        toolCalls: [{ id: `tc-${turnCount}`, name: 'finish', input: { summary: `turn ${turnCount}` } }],
      }
    },
  }

  const reconTool = createReconTool([readTool], () => countingModel)
  const ctx = makeContext()

  const result = await reconTool.execute(
    { prompt: 'test', maxTurns: 3 },
    ctx,
  )

  const parsed = JSON.parse(result.content)
  assert.equal(parsed.status, 'completed')
  // Should finish in 1 turn since model always calls finish
  assert.ok(parsed.turnsUsed <= 3, `used ${parsed.turnsUsed} turns, expected <= 3`)
})

test('run_reconnaissance returns finish summary, not intermediate text', async () => {
  const readTool = buildTool({
    name: 'read_tool',
    description: 'read',
    inputSchema: {},
    async execute() { return { content: 'data' } },
  })

  let turn = 0
  const model: ModelAdapter = {
    async complete() {
      turn++
      if (turn === 1) {
        // Intermediate turn: assistant text + tool call (this text should NOT be the findings)
        return {
          content: 'Let me look at the data first, this is intermediate reasoning.',
          toolCalls: [{ id: 'tc-1', name: 'read_tool', input: {} }],
        }
      }
      // Final turn: finish with the real conclusion
      return {
        content: '',
        toolCalls: [{ id: 'tc-2', name: 'finish', input: { summary: 'FINAL CONCLUSION: 3 of 5 models runnable.' } }],
      }
    },
  }

  const reconTool = createReconTool([readTool], () => model)
  const ctx = makeContext()
  const result = await reconTool.execute({ prompt: 'investigate' }, ctx)
  const parsed = JSON.parse(result.content)

  assert.ok(parsed.findings.includes('FINAL CONCLUSION'), 'findings come from finish summary')
  assert.ok(!parsed.findings.includes('intermediate reasoning'), 'findings are not intermediate text')
})

test('run_reconnaissance reports subagent progress via onProgress', async () => {
  const readTool = buildTool({
    name: 'read_tool',
    description: 'read',
    inputSchema: {},
    async execute() { return { content: 'data' } },
  })

  const model: ModelAdapter = {
    async complete() {
      return {
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'finish', input: { summary: 'done' } }],
      }
    },
  }

  const reconTool = createReconTool([readTool], () => model)
  const ctx = makeContext()
  const progressMessages: string[] = []
  await reconTool.execute({ prompt: 'investigate' }, ctx, ev => progressMessages.push(ev.message))

  assert.ok(progressMessages.length > 0, 'onProgress was called at least once')
  assert.ok(progressMessages.some(m => m.includes('侦察子代理')), 'progress messages are prefixed')
})

test('run_reconnaissance uses lazy model accessor', async () => {
  let modelCreated = false
  const readTool = buildTool({
    name: 'read_tool',
    description: 'read',
    inputSchema: {},
    async execute() { return { content: 'data' } },
  })

  const reconTool = createReconTool([readTool], () => {
    modelCreated = true
    return {
      async complete() {
        return {
          content: '',
          toolCalls: [{ id: 'tc-1', name: 'finish', input: { summary: 'done' } }],
        }
      },
    }
  })

  assert.equal(modelCreated, false, 'model not created at tool construction time')
  const ctx = makeContext()
  await reconTool.execute({ prompt: 'test' }, ctx)
  assert.equal(modelCreated, true, 'model created at execution time')
})
