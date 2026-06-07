import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FakeModelAdapter } from '@gsms/agent-core'
import { SkillRegistry } from '@gsms/skills-core'
import {
  AgentSessionApiClient,
  InvestAgentWorker,
  buildWorkflowResumeContext,
  inferWorkflowBoundary,
  workflowToolFilter,
} from '../src/index.ts'
import { ToolRegistry, type AgentContext, type AgentTool, ArtifactStore, DomainStateStore } from '@gsms/agent-core'
import type { PersistedAgentSession } from '../src/worker/AgentSessionApiClient.ts'

function session(): PersistedAgentSession {
  return {
    id: 'session-1',
    scene_id: 'scene-1',
    status: 'queued',
    domain_state: { sceneId: 'scene-1' },
    artifacts: [],
    model_config: { model_id: 'fake' },
  }
}

test('worker claims a queued session and checkpoints a completed Agent run', async () => {
  const actions: string[] = []
  const events: string[] = []
  const current = session()
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/messages')) return response([{ id: 'm1', role: 'user', content: 'Assess carbon' }])
    if (url.endsWith('/confirmations')) return response([])
    if (url.endsWith('/events') && init?.method === 'POST') {
      events.push(JSON.parse(String(init.body)).event_type)
      return response({ id: events.length, type: events.at(-1), data: {} }, 201)
    }
    if (url.endsWith('/checkpoint')) {
      const body = JSON.parse(String(init?.body))
      actions.push(body.action)
      current.status = body.action === 'start' ? 'running' : 'idle'
      return response(current)
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-worker-'))
  try {
    const worker = new InvestAgentWorker({
      gsmsUrl: 'http://gsms',
      proxyToken: 'token',
      workspace,
      skills: new SkillRegistry(),
      sessionApi: new AgentSessionApiClient('http://gsms', fetch),
      modelFactory: () =>
        new FakeModelAdapter([
          {
            content: '',
            toolCalls: [{ id: '1', name: 'finish', input: { summary: 'Done', evidence: ['scene-1'] } }],
          },
        ]),
    })

    assert.equal(await worker.runOnce(), true)
    assert.deepEqual(actions, ['start', 'complete'])
    assert.deepEqual(events, ['run.started', 'model.responded', 'tool.started', 'tool.completed', 'run.completed'])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('worker requests confirmation and pauses before a write tool', async () => {
  const actions: string[] = []
  const checkpoints: Array<Record<string, unknown>> = []
  const confirmations: Array<{ id: string; status: string; payload: Record<string, unknown> }> = []
  const current = session()
  current.domain_state = {
    sceneId: 'scene-1',
    modelId: 'carbon',
    matchingContextId: 'ctx-carbon',
    jobId: 'job-1',
    phase: 'results-ready-for-interpretation',
  }
  current.artifacts = [{
    id: 'schema',
    type: 'model-input-schema',
    createdBy: 'tool',
    createdAt: new Date().toISOString(),
    data: { modelId: 'carbon', displayName: 'Carbon', version: '3.17.2', slots: [] },
    metadata: { modelId: 'carbon' },
  }]
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/messages')) return response([{ id: 'm1', role: 'user', content: 'Write report' }])
    if (url.endsWith('/checkpoint')) {
      const body = JSON.parse(String(init?.body))
      actions.push(body.action)
      checkpoints.push(body)
      current.status = body.action === 'pause' ? 'awaiting_confirmation' : 'running'
      return response(current)
    }
    if (url.endsWith('/confirmations') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      confirmations.push({ id: 'c1', status: 'pending', payload: body.payload })
      current.status = 'awaiting_confirmation'
      return response(confirmations[0])
    }
    if (url.endsWith('/confirmations')) return response(confirmations)
    throw new Error(`Unexpected request: ${url}`)
  }
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-worker-'))
  try {
    const worker = new InvestAgentWorker({
      gsmsUrl: 'http://gsms',
      proxyToken: 'token',
      workspace,
      skills: new SkillRegistry(),
      sessionApi: new AgentSessionApiClient('http://gsms', fetch),
      modelFactory: () =>
        new FakeModelAdapter([
          {
            content: '',
            toolCalls: [
              {
                id: '1',
                name: 'write_invest_report',
                input: { resultSummary: 'Evidence-backed summary' },
              },
            ],
          },
        ]),
    })

    assert.equal(await worker.runOnce(), true)
    assert.deepEqual(actions, ['start', 'pause'])
    assert.equal(confirmations[0]?.payload.tool, 'write_invest_report')
    assert.match(String(confirmations[0]?.payload.authorizationKey), /job-1/)
    assert.equal((checkpoints[1]?.domain_state as Record<string, unknown>)?.phase, 'results-ready-for-interpretation')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('approved report permission survives regenerated report wording for the same job', async () => {
  const actions: string[] = []
  const current = session()
  current.domain_state = {
    sceneId: 'scene-1',
    modelId: 'carbon',
    matchingContextId: 'ctx-carbon',
    jobId: 'job-1',
    phase: 'results-ready-for-interpretation',
  }
  current.artifacts = [{
    id: 'schema',
    type: 'model-input-schema',
    createdBy: 'tool',
    createdAt: new Date().toISOString(),
    data: { modelId: 'carbon', displayName: 'Carbon', version: '3.17.2', slots: [] },
    metadata: { modelId: 'carbon' },
  }]
  const confirmations = [{
    id: 'approved-report',
    status: 'approved',
    payload: {
      tool: 'write_invest_report',
      risk: 'write',
      input: { resultSummary: 'Earlier wording' },
      authorizationKey: '{"jobId":"job-1","sceneId":"scene-1","tool":"write_invest_report"}',
    },
  }]
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/messages')) return response([{ id: 'm1', role: 'user', content: 'Write report' }])
    if (url.endsWith('/confirmations/approved-report/consume')) {
      confirmations[0]!.status = 'consumed'
      return response(confirmations[0])
    }
    if (url.endsWith('/confirmations')) return response(confirmations)
    if (url.endsWith('/checkpoint')) {
      const body = JSON.parse(String(init?.body))
      actions.push(body.action)
      current.status = body.action === 'start' ? 'running' : 'idle'
      return response(current)
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-worker-'))
  try {
    const worker = new InvestAgentWorker({
      gsmsUrl: 'http://gsms',
      proxyToken: 'token',
      workspace,
      skills: new SkillRegistry(),
      sessionApi: new AgentSessionApiClient('http://gsms', fetch),
      modelFactory: () =>
        new FakeModelAdapter([
          {
            content: '',
            toolCalls: [{
              id: '1',
              name: 'write_invest_report',
              input: { resultSummary: 'Regenerated wording for the same job' },
            }],
          },
          {
            content: '',
            toolCalls: [{
              id: '2',
              name: 'finish',
              input: { summary: 'Report written', evidence: ['runs/job-1/report.md'] },
            }],
          },
        ]),
    })

    assert.equal(await worker.runOnce(), true)
    assert.deepEqual(actions, ['start', 'complete'])
    assert.equal(confirmations[0]?.status, 'consumed')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('worker does not fail a session when another worker wins the claim', async () => {
  const actions: string[] = []
  const current = session()
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/checkpoint')) {
      const body = JSON.parse(String(init?.body))
      actions.push(body.action)
      return response({ detail: 'Session is already running.' }, 409)
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-worker-'))
  try {
    const worker = new InvestAgentWorker({
      gsmsUrl: 'http://gsms',
      proxyToken: 'token',
      workspace,
      skills: new SkillRegistry(),
      sessionApi: new AgentSessionApiClient('http://gsms', fetch),
      modelFactory: () => new FakeModelAdapter([]),
    })

    assert.equal(await worker.runOnce(), true)
    assert.deepEqual(actions, ['start'])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('workflow resume context directs validation to reuse the persisted binding report', () => {
  const context = buildWorkflowResumeContext(
    { phase: 'ready-for-validation', modelId: 'carbon' },
    [
      { id: 'schema', type: 'model-input-schema', metadata: { modelId: 'carbon' } },
      { id: 'report', type: 'binding-report', metadata: { modelId: 'carbon' } },
      { id: 'old-report', type: 'binding-report', metadata: { modelId: 'habitat_quality' } },
    ],
  )

  assert.match(context, /Call validate_binding_report directly/)
  assert.match(context, /do not reload schemas, retrieve candidates, or submit another report/)
  assert.match(context, /"binding-report":2/)
  assert.match(context, /"currentCounts":\{"model-input-schema":1,"binding-report":1\}/)
})

test('workflow resume context continues interpretation without repeating completed stages', () => {
  assert.match(
    buildWorkflowResumeContext(
      { phase: 'outputs-inspected', modelId: 'carbon' },
      [{ id: 'outputs', type: 'job-output-inventory', metadata: { modelId: 'carbon' } }],
    ),
    /Call interpret_invest_results directly.*Do not inspect outputs again/,
  )
  assert.match(
    buildWorkflowResumeContext(
      { phase: 'results-ready-for-interpretation', modelId: 'carbon' },
      [{ id: 'context', type: 'result-interpretation-context', metadata: { modelId: 'carbon' } }],
    ),
    /Call write_invest_report directly.*do not inspect outputs/,
  )
})

test('worker fails a progress-only run that reaches its turn limit instead of presenting it as complete', async () => {
  const actions: string[] = []
  const current = session()
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/messages')) return response([{ id: 'm1', role: 'user', content: 'Validate bindings' }])
    if (url.endsWith('/confirmations')) return response([])
    if (url.endsWith('/checkpoint')) {
      const body = JSON.parse(String(init?.body))
      actions.push(body.action)
      current.status = body.action === 'start' ? 'running' : 'failed'
      return response(current)
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  const workspace = await mkdtemp(join(tmpdir(), 'gsms-worker-'))
  try {
    const worker = new InvestAgentWorker({
      gsmsUrl: 'http://gsms',
      proxyToken: 'token',
      workspace,
      skills: new SkillRegistry(),
      sessionApi: new AgentSessionApiClient('http://gsms', fetch),
      modelFactory: () =>
        new FakeModelAdapter([
          {
            content: '',
            toolCalls: [{
              id: '1',
              name: 'update_goal',
              input: { progress: 'Submitting binding report' },
            }],
          },
        ]),
      maxTurns: 1,
    })

    assert.equal(await worker.runOnce(), true)
    assert.deepEqual(actions, ['start', 'fail'])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('matching boundary hides validation, confirmation, and execution tools', () => {
  assert.equal(inferWorkflowBoundary('为 Carbon 模型匹配当前场景数据，但不要执行。'), 'matching')
  assert.equal(inferWorkflowBoundary('验证当前绑定，如果通过，准备执行。'), 'confirmation')
  const tools = new ToolRegistry([
    stubTool('finish'),
    stubTool('get_invest_model_schema'),
    stubTool('finalize_data_matching'),
    stubTool('validate_binding_report'),
    stubTool('confirm_validation_snapshot'),
    stubTool('execute_validated_snapshot'),
  ])
  const artifacts = new ArtifactStore()
  artifacts.createMany([
    {
      type: 'model-input-schema',
      createdBy: 'tool',
      data: {
        modelId: 'carbon',
        displayName: 'Carbon',
        version: '3.19.0',
        slots: [],
      },
      metadata: { modelId: 'carbon' },
    },
    {
      type: 'binding-report',
      createdBy: 'agent',
      data: {},
      metadata: { modelId: 'carbon', matchingContextId: 'ctx-carbon' },
    },
  ])
  const context = {
    workspace: process.cwd(),
    goal: {
      objective: 'match',
      status: 'active' as const,
      turnCount: 1,
      maxTurns: 10,
      evidence: [],
      remainingIssues: [],
      startedAt: new Date().toISOString(),
    },
    artifacts,
    domainState: new DomainStateStore({
      modelId: 'carbon',
      matchingContextId: 'ctx-carbon',
      phase: 'ready-for-validation',
    }),
  } satisfies AgentContext
  const filter = workflowToolFilter('matching')

  assert.deepEqual(
    tools.list().filter(tool => filter(tool, context)).map(tool => tool.name),
    ['finish'],
    'after matching is finalized, only finish remains visible at the matching boundary',
  )
  assert.equal(filter(stubTool('validate_binding_report'), context), false)
  assert.equal(filter(stubTool('execute_validated_snapshot'), context), false)
})

function stubTool(name: string): AgentTool {
  return {
    name,
    description: name,
    risk: 'read',
    inputSchema: { type: 'object' },
    async execute() {
      return { content: name }
    },
  }
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
