import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SkillRegistry, SkillTool } from '@gsms/skills-core'
import {
  AgentRuntime,
  FakeModelAdapter,
  PermissionManager,
  ToolRegistry,
  createSkillAgentTool,
  finishTool,
  readFileTool,
  updateGoalTool,
  writeFileTool,
  type AgentTool,
} from '../src/index.ts'

test('agent proactively selects a skill, acts, and finishes with evidence', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'clean-agent-'))
  await writeFile(join(workspace, 'note.txt'), 'old content', 'utf8')

  const skills = new SkillRegistry()
  skills.replace([
    {
      name: 'edit-note',
      description: 'Use when updating note.txt',
      instructions: 'Read note.txt, then replace it with the requested content: {{args}}',
      source: 'user',
      allowedTools: ['read_file', 'write_file'],
      userInvocable: true,
      modelInvocable: true,
      execution: 'inline',
    },
  ])

  const model = new FakeModelAdapter([
    {
      content: '',
      toolCalls: [{ id: '1', name: 'skill', input: { skill: 'edit-note', args: 'new content' } }],
    },
    {
      content: '',
      toolCalls: [{ id: '2', name: 'read_file', input: { path: 'note.txt' } }],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '3',
          name: 'write_file',
          input: { path: 'note.txt', content: 'new content' },
        },
      ],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '4',
          name: 'finish',
          input: {
            summary: 'Updated note.txt',
            evidence: ['note.txt now contains new content'],
          },
        },
      ],
    },
  ])

  const tools = new ToolRegistry([readFileTool, writeFileTool, updateGoalTool, finishTool])
  tools.register(
    createSkillAgentTool(new SkillTool(skills), {
      availableTools: () => ['read_file', 'write_file'],
    }),
  )

  const result = await new AgentRuntime({
    model,
    tools,
    skills,
    workspace,
    permissions: new PermissionManager({ approve: () => 'allow' }),
  }).run('Update note.txt to new content')

  assert.equal(result.goal.status, 'completed')
  assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'new content')
  assert.match(model.requests[0]!.messages[0]!.content, /edit-note/)
  assert.doesNotMatch(model.requests[0]!.messages[0]!.content, /Read note\.txt/)
  assert.ok(
    model.requests[1]!.messages.some(
      message => message.role === 'user' && message.hidden && /Read note\.txt/.test(message.content),
    ),
  )
  const secondRequestMessages = model.requests[1]!.messages
  const skillToolResultIndex = secondRequestMessages.findIndex(
    message => message.role === 'tool' && message.toolCallId === '1',
  )
  const skillInstructionsIndex = secondRequestMessages.findIndex(
    message => message.role === 'user' && message.hidden,
  )
  assert.ok(skillToolResultIndex >= 0)
  assert.ok(skillInstructionsIndex > skillToolResultIndex)
  assert.deepEqual(
    model.requests[1]!.tools.map(tool => tool.name).sort(),
    ['finish', 'read_file', 'skill', 'update_goal', 'write_file'].sort(),
  )
})

test('active skill scope denies tools outside its allowlist', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'clean-agent-scope-'))
  const skills = new SkillRegistry()
  skills.replace([
    {
      name: 'read-only',
      description: 'Read-only investigation',
      instructions: 'Only inspect.',
      source: 'user',
      allowedTools: ['read_file'],
      userInvocable: true,
      modelInvocable: true,
      execution: 'inline',
    },
  ])
  const model = new FakeModelAdapter([
    {
      content: '',
      toolCalls: [{ id: '1', name: 'skill', input: { skill: 'read-only' } }],
    },
    {
      content: '',
      toolCalls: [{ id: '2', name: 'write_file', input: { path: 'x.txt', content: 'x' } }],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '3',
          name: 'finish',
          input: { status: 'blocked', summary: 'Write denied', remainingIssues: ['No write access'] },
        },
      ],
    },
  ])
  const tools = new ToolRegistry([readFileTool, writeFileTool, finishTool])
  tools.register(
    createSkillAgentTool(new SkillTool(skills), {
      availableTools: () => ['read_file', 'write_file'],
    }),
  )

  const result = await new AgentRuntime({
    model,
    tools,
    skills,
    workspace,
    permissions: new PermissionManager({ approve: () => 'allow' }),
  }).run('Try a forbidden write')

  assert.equal(result.goal.status, 'blocked')
  assert.ok(
    result.messages.some(
      message => message.role === 'tool' && message.content.includes('Permission denied'),
    ),
  )
  assert.ok(!model.requests[1]!.tools.some(tool => tool.name === 'write_file'))
})

test('runtime fails safely when max turns are reached', async () => {
  const model = new FakeModelAdapter([{ content: 'Thinking without acting' }])
  const result = await new AgentRuntime({
    model,
    tools: new ToolRegistry(),
    skills: new SkillRegistry(),
    workspace: process.cwd(),
    maxTurns: 1,
  }).run('Never-ending goal')

  assert.equal(result.goal.status, 'failed')
  assert.match(result.goal.remainingIssues[0]!, /maximum turns/)
})

test('runtime pauses when tool permission is deferred', async () => {
  const model = new FakeModelAdapter([
    { content: '', toolCalls: [{ id: '1', name: 'write_file', input: { path: 'x', content: 'y' } }] },
  ])
  const result = await new AgentRuntime({
    model,
    tools: new ToolRegistry([writeFileTool]),
    skills: new SkillRegistry(),
    workspace: process.cwd(),
    permissions: new PermissionManager({ approve: () => 'defer' }),
  }).run('Write a file after confirmation')

  assert.equal(result.goal.status, 'blocked')
  assert.match(result.goal.remainingIssues[0]!, /Awaiting user confirmation/)
})

test('runtime persists tool artifacts, domain state patches, and diagnostics', async () => {
  const inspectDataTool: AgentTool = {
    name: 'inspect_data',
    description: 'Inspect a data asset',
    risk: 'read',
    inputSchema: { type: 'object' },
    async execute() {
      return {
        content: 'Inspected LULC raster',
        artifacts: [
          {
            id: 'lulc-card',
            type: 'data-card',
            createdBy: 'tool',
            data: { assetType: 'raster', sampledCodes: [1, 2] },
          },
        ],
        statePatch: {
          phase: 'matching-slots',
          slots: { lulc: { status: 'candidate-found', artifactId: 'lulc-card' } },
        },
        diagnostics: [
          {
            code: 'RASTER_CODES_SAMPLED',
            message: 'Sampled two raster codes',
            severity: 'info',
            relatedArtifactIds: ['lulc-card'],
          },
        ],
      }
    },
  }
  const model = new FakeModelAdapter([
    {
      content: '',
      toolCalls: [{ id: '1', name: 'inspect_data', input: {} }],
    },
    {
      content: '',
      toolCalls: [
        {
          id: '2',
          name: 'finish',
          input: { summary: 'Inspected data', evidence: ['lulc-card'] },
        },
      ],
    },
  ])

  const result = await new AgentRuntime({
    model,
    tools: new ToolRegistry([inspectDataTool, finishTool]),
    skills: new SkillRegistry(),
    workspace: process.cwd(),
  }).run('Inspect the available LULC data')

  assert.equal(result.artifacts[0]?.id, 'lulc-card')
  assert.deepEqual(result.domainState, {
    phase: 'matching-slots',
    slots: { lulc: { status: 'candidate-found', artifactId: 'lulc-card' } },
  })
  assert.equal(result.diagnostics[0]?.code, 'RASTER_CODES_SAMPLED')
  assert.ok(result.transcript.some(event => event.type === 'artifact'))
  assert.ok(result.transcript.some(event => event.type === 'state'))
  assert.ok(result.transcript.some(event => event.type === 'diagnostic'))
})
