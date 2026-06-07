import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FakeModelAdapter,
  ToolRegistry,
  type AgentTool,
} from '@gsms/agent-core'
import {
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
    name: 'remember_scene_fact',
    description: 'Persist a scene fact',
    risk: 'read',
    inputSchema: { type: 'object' },
    async execute() {
      return {
        content: 'remembered',
        artifacts: [{ type: 'scene-fact', createdBy: 'tool', data: { value: 42 } }],
        statePatch: { rememberedValue: 42 },
      }
    },
  }
  const model = new FakeModelAdapter([
    {
      content: '',
      toolCalls: [{ id: '1', name: 'remember_scene_fact', input: {} }],
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

  await session.send('Remember the scene fact')
  await session.send('Use what you remembered')

  assert.equal(session.status().turns, 2)
  assert.equal(session.domainState.snapshot().rememberedValue, 42)
  assert.equal(session.artifacts.list('scene-fact').length, 1)
})
