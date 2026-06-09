import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTool } from '../src/tools/buildTool.ts'

test('buildTool provides default risk=read', () => {
  const tool = buildTool({
    name: 'test',
    description: 'test tool',
    inputSchema: {},
    async execute() { return { content: 'ok' } },
  })
  assert.equal(tool.risk, 'read')
  assert.equal(tool.name, 'test')
  assert.equal(tool.description, 'test tool')
  assert.equal(tool.persistResultAboveBytes, undefined)
})

test('buildTool allows explicit risk and persistResultAboveBytes', () => {
  const tool = buildTool({
    name: 'test',
    description: 'test tool',
    risk: 'write',
    persistResultAboveBytes: 5000,
    inputSchema: { type: 'object' },
    async execute() { return { content: 'ok' } },
  })
  assert.equal(tool.risk, 'write')
  assert.equal(tool.persistResultAboveBytes, 5000)
})

test('buildTool preserves execute function', async () => {
  const tool = buildTool({
    name: 'test',
    description: 'test tool',
    inputSchema: {},
    async execute(input) {
      return { content: `received: ${JSON.stringify(input)}` }
    },
  })
  const result = await tool.execute({ key: 'value' }, {} as any)
  assert.equal(result.content, 'received: {"key":"value"}')
})

test('buildTool preserves artifacts and statePatch in result', async () => {
  const tool = buildTool({
    name: 'test',
    description: 'test tool',
    inputSchema: {},
    async execute() {
      return {
        content: 'ok',
        artifacts: [{ type: 'test-artifact', createdBy: 'tool', data: { x: 1 } }],
        statePatch: { phase: 'done' },
      }
    },
  })
  const result = await tool.execute({}, {} as any)
  assert.equal(result.artifacts?.length, 1)
  assert.equal(result.statePatch?.phase, 'done')
})
