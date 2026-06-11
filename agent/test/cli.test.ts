import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ArtifactStore,
  DomainStateStore,
  FakeModelAdapter,
  ToolRegistry,
  type AgentContext,
  type AgentTool,
} from '@gsms/agent-core'
import {
  enforceWorkflowPhaseTransitions,
  GsmsBootstrapClient,
  InvestAgentSession,
  parseCliArguments,
  registerSessionControlTools,
  resolveCliConfig,
} from '../src/index.ts'
import { SkillRegistry } from '@gsms/skills-core'

test('CLI config reuses the default GSMS provider and injects the API key from env', async () => {
  const fetch = async (input: string | URL | Request) => {
    assert.match(String(input), /api\/settings\/llm-providers$/)
    return new Response(JSON.stringify([
      {
        name: 'GSMS default',
        model_id: 'qwen-plus',
        base_url: 'https://example.test/v1/',
        is_default: true,
      },
    ]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const config = await resolveCliConfig(parseCliArguments(['--scene', 'scene-1']), {
    fetch,
    env: { INVEST_AGENT_API_KEY: 'secret', INVEST_AGENT_WORKSPACE: 'workspace' },
  })

  assert.equal(config.model, 'qwen-plus')
  assert.equal(config.modelBaseUrl, 'https://example.test/v1')
  assert.equal(config.apiKey, 'secret')
  assert.equal(config.intentClassifierModel, 'qwen-plus')
  assert.equal(config.intentClassifierBaseUrl, 'https://example.test/v1')
  assert.equal(config.intentClassifierApiKey, 'secret')
  assert.equal(config.sceneId, 'scene-1')
})

test('CLI uses the GSMS provider proxy when the saved default provider owns the secret', async () => {
  const fetch = async () =>
    new Response(JSON.stringify([
      {
        model_id: 'configured-model',
        base_url: 'https://provider.example/v1',
        is_default: true,
        has_api_key: true,
      },
    ]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const config = await resolveCliConfig(parseCliArguments([]), {
    fetch,
    env: { GSMS_AGENT_PROXY_TOKEN: 'proxy-token' },
  })

  assert.equal(config.model, 'configured-model')
  assert.equal(config.modelBaseUrl, 'http://127.0.0.1:8000/api/agent')
  assert.equal(config.apiKey, 'proxy-token')
})

test('CLI flags override GSMS provider metadata', async () => {
  const config = await resolveCliConfig(
    parseCliArguments([
      '--model=model-override',
      '--base-url',
      'http://localhost:11434/v1',
      '--api-key',
      'key-override',
      '--max-turns',
      '12',
      '--yes',
    ]),
    {
      fetch: async () => new Response('[]', { status: 200 }),
      env: {},
    },
  )

  assert.equal(config.model, 'model-override')
  assert.equal(config.modelBaseUrl, 'http://localhost:11434/v1')
  assert.equal(config.maxTurns, 12)
  assert.equal(config.yes, true)
})

test('CLI config can enable a separate intent classifier model', async () => {
  const config = await resolveCliConfig(
    parseCliArguments([
      '--model=model-main',
      '--base-url',
      'http://main.example/v1',
      '--api-key',
      'main-key',
      '--intent-classifier-model',
      'intent-small',
      '--intent-classifier-base-url',
      'http://intent.example/v1/',
      '--intent-classifier-api-key',
      'intent-key',
    ]),
    {
      fetch: async () => new Response('[]', { status: 200 }),
      env: {},
    },
  )

  assert.equal(config.intentClassifierModel, 'intent-small')
  assert.equal(config.intentClassifierBaseUrl, 'http://intent.example/v1')
  assert.equal(config.intentClassifierApiKey, 'intent-key')
})

test('CLI config can disable intent classifier fallback', async () => {
  const config = await resolveCliConfig(parseCliArguments(['--model=main', '--api-key=key', '--disable-intent-classifier']), {
    fetch: async () => new Response('[]', { status: 200 }),
    env: {},
  })

  assert.equal(config.intentClassifierModel, undefined)
  assert.equal(config.intentClassifierBaseUrl, undefined)
  assert.equal(config.intentClassifierApiKey, undefined)
})

test('GSMS bootstrap client verifies health and lists scenes', async () => {
  const fetch = async (input: string | URL | Request) => {
    const url = String(input)
    const payload = url.endsWith('/health')
      ? { status: 'ok' }
      : [{ id: 'scene-1', name: 'Willamette', region: 'Oregon' }]
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const client = new GsmsBootstrapClient('http://gsms', fetch)
  await client.health()
  const scenes = await client.listScenes()

  assert.equal(scenes[0]?.id, 'scene-1')
  assert.equal(scenes[0]?.name, 'Willamette')
})

test('multi-turn session preserves domain state and artifacts between user messages', async () => {
  const rememberTool: AgentTool = {
    name: 'list_invest_models',
    description: 'Persist a scene fact',
    risk: 'read',
    inputSchema: { type: 'object' },
    async execute() {
      return {
        content: 'remembered',
        artifacts: [{ type: 'scene-model-readiness', createdBy: 'tool', data: { value: 42 } }],
        statePatch: { rememberedValue: 42 },
      }
    },
  }
  const model = new FakeModelAdapter([
    {
      content: '',
      toolCalls: [{ id: '1', name: 'list_invest_models', input: {} }],
    },
    {
      content: '',
      toolCalls: [{ id: '2', name: 'finish', input: { summary: 'Stored the fact', evidence: ['42'] } }],
    },
    {
      content: '',
      toolCalls: [{ id: '3', name: 'finish', input: { summary: 'Reused session context', evidence: ['42'] } }],
    },
  ])
  const registry = new ToolRegistry([rememberTool])
  const skills = new SkillRegistry()
  registerSessionControlTools(registry, skills, () => [rememberTool.name])
  const session = new InvestAgentSession({
    model,
    tools: registry,
    skills,
    workspace: process.cwd(),
    sceneId: 'scene-1',
    maxTurns: 5,
    approve: () => 'allow',
  })

  await session.send('Assess which InVEST models the current scene can run')
  await session.send('Use what you remembered')

  assert.equal(session.status().turns, 2)
  assert.equal(session.domainState.snapshot().rememberedValue, 42)
  assert.equal(session.artifacts.list('scene-model-readiness').length, 1)
})

test('workflow tool guard rejects invalid phase transitions before state is patched', async () => {
  const invalidTool: AgentTool = {
    name: 'execute_validated_snapshot',
    description: 'Invalid transition test tool',
    risk: 'read',
    inputSchema: { type: 'object' },
    async execute() {
      return { content: 'bad transition', statePatch: { phase: 'job-running' } }
    },
  }
  const context: AgentContext = {
    workspace: process.cwd(),
    goal: {
      objective: 'test transition',
      status: 'active',
      turnCount: 1,
      maxTurns: 1,
      evidence: [],
      remainingIssues: [],
      startedAt: new Date().toISOString(),
    },
    artifacts: new ArtifactStore(),
    domainState: new DomainStateStore({ phase: 'confirmed-for-execution' }),
  }
  const guarded = enforceWorkflowPhaseTransitions(invalidTool)

  await assert.rejects(
    guarded.execute({ snapshotId: 'snap-1' }, context),
    /model-job/,
  )
  assert.equal(context.domainState.snapshot().phase, 'confirmed-for-execution')
})

test('workflow tool guard accepts phase transitions backed by required evidence', async () => {
  const validTool: AgentTool = {
    name: 'execute_validated_snapshot',
    description: 'Valid transition test tool',
    risk: 'read',
    inputSchema: { type: 'object' },
    async execute() {
      return {
        content: 'ok',
        artifacts: [{ type: 'model-job', createdBy: 'tool', data: { job_id: 'job-1' } }],
        statePatch: { phase: 'job-running' },
      }
    },
  }
  const context: AgentContext = {
    workspace: process.cwd(),
    goal: {
      objective: 'test transition',
      status: 'active',
      turnCount: 1,
      maxTurns: 1,
      evidence: [],
      remainingIssues: [],
      startedAt: new Date().toISOString(),
    },
    artifacts: new ArtifactStore(),
    domainState: new DomainStateStore({ phase: 'confirmed-for-execution' }),
  }

  const result = await enforceWorkflowPhaseTransitions(validTool).execute({ snapshotId: 'snap-1' }, context)

  assert.equal(result.statePatch?.phase, 'job-running')
})

test('CLI session routes general answers without exposing domain tools or changing domain state', async () => {
  const domainTool: AgentTool = {
    name: 'get_invest_model_schema',
    description: 'Should not be visible for general answers',
    risk: 'read',
    inputSchema: { type: 'object' },
    async execute() {
      return { content: 'unexpected', statePatch: { phase: 'discovering-data' } }
    },
  }
  const model = new FakeModelAdapter([
    {
      content: '',
      toolCalls: [{ id: '1', name: 'finish', input: { summary: '1+1=2', evidence: ['arithmetic'] } }],
    },
  ])
  const registry = new ToolRegistry([domainTool])
  const skills = new SkillRegistry()
  registerSessionControlTools(registry, skills, () => [domainTool.name])
  const session = new InvestAgentSession({
    model,
    tools: registry,
    skills,
    workspace: process.cwd(),
    sceneId: 'scene-1',
    maxTurns: 5,
    approve: () => 'allow',
  })

  const result = await session.send('1+1=?')

  assert.equal(result.goal.finalSummary, '1+1=2')
  assert.deepEqual(model.requests[0]?.tools.map(tool => tool.name).sort(), ['finish', 'update_goal'])
  assert.deepEqual(session.domainState.snapshot(), { sceneId: 'scene-1', phase: 'conversation-ready' })
})
