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

test('reloading the active inline skill is idempotent', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'clean-agent-skill-repeat-'))
  const skills = new SkillRegistry()
  skills.replace([
    {
      name: 'inspect-request',
      description: 'Inspect with read tools',
      instructions: 'Inspect the current request before answering.',
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
      toolCalls: [{ id: '1', name: 'skill', input: { skill: 'inspect-request' } }],
    },
    {
      content: '',
      toolCalls: [{ id: '2', name: 'skill', input: { skill: 'inspect-request' } }],
    },
    {
      content: '',
      toolCalls: [{
        id: '3',
        name: 'finish',
        input: { summary: 'Finished with the active skill.', evidence: ['inspect-request'] },
      }],
    },
  ])

  const tools = new ToolRegistry([finishTool])
  tools.register(
    createSkillAgentTool(new SkillTool(skills), {
      availableTools: () => ['read_file'],
    }),
  )

  const result = await new AgentRuntime({
    model,
    tools,
    skills,
    workspace,
  }).run('Inspect the request')

  assert.equal(result.goal.status, 'completed')
  assert.ok(
    model.requests[2]!.messages.some(
      message =>
        message.role === 'tool' &&
        message.toolCallId === '2' &&
        /already active/.test(message.content),
    ),
  )
})

test('active skill scope denies tools outside its allowlist', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'clean-agent-scope-'))
  const skills = new SkillRegistry()
  skills.replace([
    {
      name: 'read-only',
      description: 'Read-only inspection',
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
      message => message.role === 'tool' && message.content.includes('not available'),
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
  assert.equal(result.diagnostics[0]?.code, 'AGENT_MAX_TURNS_REACHED')
})

test('runtime stops consecutive identical tool-call loops before max turns', async () => {
  const validateTool: AgentTool = {
    name: 'validate_submission',
    description: 'Validate the current submission',
    risk: 'read',
    inputSchema: { type: 'object' },
    async execute() {
      return { content: 'Validation passed' }
    },
  }
  const repeatedResponse = {
    content: 'Validating',
    toolCalls: [
      {
        id: 'ignored-by-loop-signature',
        name: 'validate_submission',
        input: { modelId: 'example' },
      },
    ],
  }
  const model = new FakeModelAdapter(Array.from({ length: 20 }, () => repeatedResponse))
  const result = await new AgentRuntime({
    model,
    tools: new ToolRegistry([validateTool]),
    skills: new SkillRegistry(),
    workspace: process.cwd(),
    maxTurns: 20,
    maxRepeatedToolCalls: 3,
  }).run('Validate the binding once')

  assert.equal(result.goal.status, 'failed')
  assert.equal(result.goal.turnCount, 3)
  assert.equal(result.diagnostics[0]?.code, 'AGENT_REPEATED_TOOL_CALL_LOOP')
  assert.match(result.goal.remainingIssues[0]!, /validate_submission/)
  assert.equal(
    result.transcript.filter(event => event.type === 'tool_call').length,
    2,
    'the repeated call that triggers the guard must not execute',
  )
})

test('runtime stops a repeated multi-tool cycle before max turns', async () => {
  const tools = ['inspect_inputs', 'validate_submission'].map<AgentTool>(name => ({
    name,
    description: name,
    risk: 'read',
    inputSchema: { type: 'object' },
    async execute() {
      return { content: `${name} completed` }
    },
  }))
  const model = new FakeModelAdapter(
    Array.from({ length: 20 }, (_, index) => ({
      content: '',
      toolCalls: [{
        id: String(index),
        name: tools[index % tools.length]!.name,
        input: { modelId: 'example' },
      }],
    })),
  )
  const result = await new AgentRuntime({
    model,
    tools: new ToolRegistry(tools),
    skills: new SkillRegistry(),
    workspace: process.cwd(),
    maxTurns: 20,
    maxRepeatedToolCalls: 3,
  }).run('Validate the binding once')

  assert.equal(result.goal.status, 'failed')
  assert.equal(result.goal.turnCount, 6)
  assert.match(result.goal.remainingIssues[0]!, /inspect_inputs.*validate_submission/)
})

test('runtime stops one tool after three varied failures without progress', async () => {
  const failingTool: AgentTool = {
    name: 'submit_report',
    description: 'Submit a report',
    risk: 'control',
    inputSchema: { type: 'object' },
    async execute() {
      throw new Error('Required evidence is incomplete')
    },
  }
  const model = new FakeModelAdapter(
    Array.from({ length: 10 }, (_, index) => ({
      content: '',
      toolCalls: [{
        id: String(index),
        name: 'submit_report',
        input: { attempt: index },
      }],
    })),
  )
  const result = await new AgentRuntime({
    model,
    tools: new ToolRegistry([failingTool]),
    skills: new SkillRegistry(),
    workspace: process.cwd(),
    maxTurns: 10,
  }).run('Submit the report')

  assert.equal(result.goal.status, 'failed')
  assert.equal(result.goal.turnCount, 3)
  assert.equal(result.diagnostics[0]?.code, 'AGENT_TOOL_FAILURE_LOOP')
  assert.match(result.goal.remainingIssues[0]!, /failed 3 consecutive times/)
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

test('runtime refuses a registered tool hidden by the workflow filter', async () => {
  let executed = false
  const hiddenTool: AgentTool = {
    name: 'hidden_execute',
    description: 'Hidden execution tool',
    risk: 'control',
    inputSchema: { type: 'object' },
    async execute() {
      executed = true
      return { content: 'executed' }
    },
  }
  const model = new FakeModelAdapter([
    { content: '', toolCalls: [{ id: '1', name: 'hidden_execute', input: {} }] },
    { content: '', toolCalls: [{ id: '2', name: 'finish', input: { status: 'blocked', summary: 'Hidden tool unavailable' } }] },
  ])
  const result = await new AgentRuntime({
    model,
    tools: new ToolRegistry([hiddenTool, finishTool]),
    skills: new SkillRegistry(),
    workspace: process.cwd(),
    toolFilter: tool => tool.name === 'finish',
  }).run('Do not execute hidden tools')

  assert.equal(executed, false)
  assert.equal(result.goal.status, 'blocked')
  assert.match(result.messages.find(message => message.role === 'tool')?.content ?? '', /not available/)
})

test('update_goal records progress without terminating the objective', async () => {
  const model = new FakeModelAdapter([
    {
      content: '',
      toolCalls: [{
        id: '1',
        name: 'update_goal',
        input: { progress: 'Submitting report', nextStep: 'Submit it' },
      }],
    },
    {
      content: '',
      toolCalls: [{
        id: '2',
        name: 'finish',
        input: { summary: 'Report submitted', evidence: ['decision-report'] },
      }],
    },
  ])
  const result = await new AgentRuntime({
    model,
    tools: new ToolRegistry([updateGoalTool, finishTool]),
    skills: new SkillRegistry(),
    workspace: process.cwd(),
  }).run('Submit a report')

  assert.equal(result.goal.status, 'completed')
  assert.equal(result.goal.progress, 'Submitting report')
  assert.equal(result.goal.finalSummary, 'Report submitted')
})

test('runtime persists tool artifacts, domain state patches, and diagnostics', async () => {
  const inspectDataTool: AgentTool = {
    name: 'inspect_data',
    description: 'Inspect a data asset',
    risk: 'read',
    inputSchema: { type: 'object' },
    async execute() {
      return {
        content: 'Inspected data record',
        artifacts: [
          {
            id: 'record-card',
            type: 'data-card',
            createdBy: 'tool',
            data: { assetType: 'record', sampledValues: [1, 2] },
          },
        ],
        statePatch: {
          phase: 'inputs-reviewed',
          items: { primary: { status: 'candidate-found', artifactId: 'record-card' } },
        },
        diagnostics: [
          {
            code: 'VALUES_SAMPLED',
            message: 'Sampled two values',
            severity: 'info',
            relatedArtifactIds: ['record-card'],
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
          input: { summary: 'Inspected data', evidence: ['record-card'] },
        },
      ],
    },
  ])

  const result = await new AgentRuntime({
    model,
    tools: new ToolRegistry([inspectDataTool, finishTool]),
    skills: new SkillRegistry(),
    workspace: process.cwd(),
  }).run('Inspect the available data')

  assert.equal(result.artifacts[0]?.id, 'record-card')
  assert.deepEqual(result.domainState, {
    phase: 'inputs-reviewed',
    items: { primary: { status: 'candidate-found', artifactId: 'record-card' } },
  })
  assert.equal(result.diagnostics[0]?.code, 'VALUES_SAMPLED')
  assert.ok(result.transcript.some(event => event.type === 'artifact'))
  assert.ok(result.transcript.some(event => event.type === 'state'))
  assert.ok(result.transcript.some(event => event.type === 'diagnostic'))
})

test('runtime emits auditable action events without exposing sensitive tool input', async () => {
  const events: Array<{ eventType: string; data?: Record<string, unknown> }> = []
  const inspectTool: AgentTool = {
    name: 'inspect_data',
    description: 'Inspect data',
    risk: 'read',
    inputSchema: { type: 'object' },
    async execute() {
      return { content: 'Inspection completed' }
    },
  }
  const model = new FakeModelAdapter([
    {
      content: '',
      toolCalls: [{ id: '1', name: 'inspect_data', input: { path: 'input.dat', apiKey: 'secret' } }],
    },
    {
      content: '',
      toolCalls: [{ id: '2', name: 'finish', input: { summary: 'Done', evidence: ['input.dat'] } }],
    },
  ])

  await new AgentRuntime({
    model,
    tools: new ToolRegistry([inspectTool, finishTool]),
    skills: new SkillRegistry(),
    workspace: process.cwd(),
    eventSink: { emit: async event => { events.push(event) } },
  }).run('Inspect the data')

  assert.deepEqual(
    events.filter(event => event.eventType.startsWith('tool.')).map(event => event.eventType),
    ['tool.started', 'tool.completed', 'tool.started', 'tool.completed'],
  )
  const input = events.find(event => event.eventType === 'tool.started')?.data?.input as Record<string, unknown>
  assert.equal(input.apiKey, '[redacted]')
  assert.equal(events.at(-1)?.eventType, 'run.completed')
})
