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
  approvedConfirmationForDirectExecution,
  buildWorkflowResumeContext,
  evaluateDataAvailabilityPolicy,
  executionPhaseAllows,
  phaseResumeInstruction,
  workflowPhaseFilter,
  isExecutionPhase,
  WAITING_PHASES,
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
    assert.deepEqual(events, ['turn.planned', 'run.started', 'model.streaming', 'model.responded', 'tool.started', 'tool.completed', 'run.completed'])
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
    if (url.endsWith('/events') && init?.method === 'POST') {
      return response({ id: 1, type: 'event', data: {} }, 201)
    }
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
                input: { contextualExplanation: 'Evidence-backed summary' },
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
      input: { contextualExplanation: 'Earlier wording' },
      authorizationKey: '{"jobId":"job-1","sceneId":"scene-1","tool":"write_invest_report"}',
    },
  }]
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/messages')) return response([{ id: 'm1', role: 'user', content: 'Write report' }])
    if (url.endsWith('/events') && init?.method === 'POST') {
      return response({ id: 1, type: 'event', data: {} }, 201)
    }
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
              input: { contextualExplanation: 'Regenerated wording for the same job' },
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

test('approved data hub import confirmation executes exact deferred tool input before model planning', async () => {
  const actions: string[] = []
  const importBodies: Array<Record<string, unknown>> = []
  let completeCheckpoint: Record<string, unknown> | undefined
  const current = session()
  current.domain_state = {
    sceneId: 'scene-1',
    modelId: 'carbon',
    phase: 'awaiting-data-import-confirmation',
  }
  current.artifacts = [{
    id: 'proposal',
    type: 'data-hub-import-proposal',
    createdBy: 'tool',
    createdAt: new Date().toISOString(),
    data: { slots: [] },
    metadata: {
      sceneId: 'scene-1',
      modelId: 'carbon',
      proposedFileIds: ['lulc-1', 'pools-1'],
    },
  }]
  const confirmations = [{
    id: 'approved-import',
    status: 'approved',
    payload: {
      tool: 'import_data_hub_files_to_scene',
      risk: 'write',
      input: { sceneId: 'scene-1', fileIds: ['lulc-1', 'pools-1'] },
      authorizationKey: '{"input":{"fileIds":["lulc-1","pools-1"],"sceneId":"scene-1"},"tool":"import_data_hub_files_to_scene"}',
    },
  }]
  const model = new FakeModelAdapter([
    {
      content: '',
      toolCalls: [{ id: '1', name: 'finish', input: { summary: 'Imported data is available', evidence: ['scene-import-record'] } }],
    },
    {
      content: '',
      toolCalls: [{ id: '2', name: 'finish', input: { summary: 'Imported data is available', evidence: ['scene-import-record'] } }],
    },
  ])
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/messages')) return response([{ id: 'm1', role: 'user', content: '继续导入' }])
    if (url.endsWith('/events') && init?.method === 'POST') {
      return response({ id: 1, type: 'event', data: {} }, 201)
    }
    if (url.endsWith('/confirmations/approved-import/consume')) {
      confirmations[0]!.status = 'consumed'
      return response(confirmations[0])
    }
    if (url.endsWith('/confirmations')) return response(confirmations)
    if (url.endsWith('/api/matching/data-hub/import')) {
      importBodies.push(JSON.parse(String(init?.body)))
      return response({ imported: 2, skipped_existing: 0, scene_id: 'scene-1', file_ids: ['lulc-1', 'pools-1'] })
    }
    if (url.endsWith('/api/scenes/scene-1/data-cards')) {
      return response({
        data_cards: [
          {
            asset_id: 'lulc-1',
            asset_type: 'raster',
            path: '/data/lulc.tif',
            filename: 'lulc_current.tif',
            semantic_hints: ['lulc'],
            metadata: { crs: 'EPSG:26910', bounds: [0, 0, 1, 1] },
          },
          {
            asset_id: 'pools-1',
            asset_type: 'table',
            path: '/data/carbon.csv',
            filename: 'carbon_pools.csv',
            semantic_hints: ['carbon'],
            metadata: { columns: ['lucode', 'c_above', 'c_below', 'c_soil', 'c_dead'] },
          },
        ],
      })
    }
    if (url.endsWith('/checkpoint')) {
      const body = JSON.parse(String(init?.body))
      actions.push(body.action)
      if (body.action === 'complete') {
        completeCheckpoint = body
      }
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
      modelFactory: () => model,
    })

    assert.equal(await worker.runOnce(), true)
    assert.deepEqual(actions, ['start', 'complete'])
    const artifacts = completeCheckpoint?.artifacts as Array<{ type: string; metadata?: Record<string, unknown> }> | undefined
    assert.ok(artifacts?.some(artifact => artifact.type === 'scene-import-record'), 'import record persisted')
    assert.ok(artifacts?.some(artifact => artifact.type === 'gsms-scene-data-cards'), 'refreshed data cards persisted')
    assert.equal((completeCheckpoint?.domain_state as Record<string, unknown>)?.phase, 'discovering-data')
    assert.deepEqual((completeCheckpoint?.domain_state as Record<string, unknown>)?.assetIds, ['lulc-1', 'pools-1'])
    assert.equal(confirmations[0]?.status, 'consumed')
    assert.deepEqual(importBodies, [{ scene_id: 'scene-1', file_ids: ['lulc-1', 'pools-1'] }])
    assert.ok(model.requests.length >= 1, 'model may continue only after the approved import has executed')
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

test('approved direct execution is driven by tool policy instead of tool name', () => {
  const policyTool: AgentTool = {
    name: 'publish_scene_note',
    description: 'test write tool',
    risk: 'write',
    inputSchema: { type: 'object' },
    policy: { confirmation: { approvedAction: 'execute-approved-input' } },
    async execute() { return { content: 'ok' } },
  }
  const sameNameWithoutPolicy: AgentTool = {
    name: 'import_data_hub_files_to_scene',
    description: 'same historical name but no policy',
    risk: 'write',
    inputSchema: { type: 'object' },
    async execute() { return { content: 'ok' } },
  }

  assert.equal(
    approvedConfirmationForDirectExecution(
      [{ id: 'approved-note', status: 'approved', payload: { tool: 'publish_scene_note', input: { id: 'n1' } } }],
      [policyTool],
    )?.id,
    'approved-note',
  )
  assert.equal(
    approvedConfirmationForDirectExecution(
      [{ id: 'approved-import', status: 'approved', payload: { tool: 'import_data_hub_files_to_scene', input: { sceneId: 's1' } } }],
      [sameNameWithoutPolicy],
    ),
    undefined,
  )
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
    /Call analyze_invest_results directly/,
  )
  const analyzedContext = buildWorkflowResumeContext(
    { phase: 'results-analyzed', modelId: 'carbon' },
    [
      { id: 'outputs', type: 'job-output-inventory', metadata: { modelId: 'carbon' } },
      { id: 'analysis', type: 'result-analysis', metadata: { modelId: 'carbon' } },
    ],
  )
  assert.match(analyzedContext, /Call interpret_invest_results directly/)
  assert.match(analyzedContext, /do not analyze results again/)
  assert.match(
    buildWorkflowResumeContext(
      { phase: 'results-ready-for-interpretation', modelId: 'carbon' },
      [{ id: 'context', type: 'result-interpretation-context', metadata: { modelId: 'carbon' } }],
    ),
    /Call write_invest_report directly/,
  )
})

test('workflow resume context prefers one-shot required candidate retrieval after import refresh', () => {
  const context = buildWorkflowResumeContext(
    { phase: 'discovering-data', modelId: 'carbon' },
    [
      { id: 'schema', type: 'model-input-schema', data: { modelId: 'carbon', displayName: 'Carbon', version: '3.19.0', slots: [] }, metadata: { modelId: 'carbon' } },
      { id: 'cards', type: 'gsms-scene-data-cards', data: {}, metadata: { modelId: 'carbon', refreshedAfterImport: true } },
      { id: 'lulc', type: 'data-card', metadata: { modelId: 'carbon' } },
    ],
  )

  assert.match(context, /retrieve_required_input_candidates once/)
  assert.match(context, /Do not invent \*_asset_id slot names/)
  assert.match(context, /do not call retrieve_input_candidates in parallel/)
})

test('workflow resume context sends empty single-model scene to Data Hub discovery', () => {
  const context = buildWorkflowResumeContext(
    { phase: 'discovering-data', modelId: 'carbon' },
    [
      { id: 'schema', type: 'model-input-schema', data: { modelId: 'carbon', displayName: 'Carbon', version: '3.19.0', slots: [] }, metadata: { modelId: 'carbon' } },
      { id: 'cards', type: 'gsms-scene-data-cards', data: { data_cards: [] }, metadata: { modelId: 'carbon' } },
      { id: 'stale-report', type: 'sufficiency-report', metadata: { modelId: 'carbon' } },
    ],
  )

  assert.match(context, /Call discover_data_hub_candidates/)
  assert.match(context, /before retrieving candidates, assessing readiness, finalizing sufficiency/)
})

test('data availability policy is provider-aware rather than Data Hub-only', () => {
  const baseArtifacts = [
    { id: 'schema', type: 'model-input-schema', data: { modelId: 'carbon' }, metadata: { modelId: 'carbon' } },
    { id: 'cards', type: 'gsms-scene-data-cards', data: { data_cards: [] }, metadata: { modelId: 'carbon' } },
  ]
  const blocked = evaluateDataAvailabilityPolicy({ modelId: 'carbon' }, baseArtifacts)
  assert.equal(blocked.requiresExternalDiscovery, true)
  assert.equal(blocked.allowedTools.has('discover_data_hub_candidates'), true)

  const satisfied = evaluateDataAvailabilityPolicy(
    { modelId: 'carbon' },
    [...baseArtifacts, { id: 'external', type: 'data-source-discovery-report', metadata: { modelId: 'carbon', providerId: 'data-hub' } }],
  )
  assert.equal(satisfied.requiresExternalDiscovery, false)

  const unscopedGenericReport = evaluateDataAvailabilityPolicy(
    { modelId: 'carbon' },
    [...baseArtifacts, { id: 'external', type: 'data-source-discovery-report', metadata: { modelId: 'carbon' } }],
  )
  assert.equal(unscopedGenericReport.requiresExternalDiscovery, true)

  const otherProviderReport = evaluateDataAvailabilityPolicy(
    { modelId: 'carbon' },
    [...baseArtifacts, { id: 'external', type: 'data-source-discovery-report', metadata: { modelId: 'carbon', providerId: 'generic-data-source' } }],
  )
  assert.equal(otherProviderReport.requiresExternalDiscovery, false)
})

test('data availability policy can select an injected source provider', () => {
  const provider = {
    id: 'stac',
    displayName: 'STAC catalog',
    discoveryTool: 'discover_stac_candidates',
    discoveryArtifactTypes: ['stac-discovery-report'],
  }
  const baseArtifacts = [
    { id: 'schema', type: 'model-input-schema', data: { modelId: 'carbon' }, metadata: { modelId: 'carbon' } },
    { id: 'cards', type: 'gsms-scene-data-cards', data: { data_cards: [] }, metadata: { modelId: 'carbon' } },
  ]
  const blocked = evaluateDataAvailabilityPolicy({ modelId: 'carbon' }, baseArtifacts, [provider])

  assert.equal(blocked.requiresExternalDiscovery, true)
  assert.equal(blocked.discoveryTool, 'discover_stac_candidates')
  assert.equal(blocked.allowedTools.has('discover_stac_candidates'), true)
  assert.equal(blocked.allowedTools.has('discover_data_hub_candidates'), false)
  assert.match(blocked.instruction ?? '', /STAC catalog/)

  const satisfied = evaluateDataAvailabilityPolicy(
    { modelId: 'carbon' },
    [...baseArtifacts, { id: 'stac-report', type: 'stac-discovery-report', metadata: { modelId: 'carbon' } }],
    [provider],
  )
  assert.equal(satisfied.requiresExternalDiscovery, false)
})

test('worker resets mid-execution phase (results-analyzed) on new run', async () => {
  const checkpoints: Array<Record<string, unknown>> = []
  const current = session()
  current.domain_state = {
    sceneId: 'scene-1',
    modelId: 'carbon',
    matchingContextId: 'ctx-carbon',
    jobId: 'job-1',
    phase: 'results-analyzed', // mid-execution, should be reset
  }
  current.artifacts = [
    { id: 'schema', type: 'model-input-schema', createdBy: 'tool', createdAt: new Date().toISOString(), data: { modelId: 'carbon' }, metadata: { modelId: 'carbon' } },
    { id: 'job', type: 'model-job', createdBy: 'tool', createdAt: new Date().toISOString(), data: { job_id: 'job-1' }, metadata: { modelId: 'carbon' } },
    { id: 'status', type: 'job-status', createdBy: 'tool', createdAt: new Date().toISOString(), data: { status: 'succeeded' }, metadata: { modelId: 'carbon' } },
    { id: 'validation', type: 'validation-report', createdBy: 'tool', createdAt: new Date().toISOString(), data: { status: 'passed' }, metadata: { modelId: 'carbon' } },
    { id: 'confirmation', type: 'confirmation-record', createdBy: 'tool', createdAt: new Date().toISOString(), data: { status: 'confirmed' }, metadata: { modelId: 'carbon' } },
    { id: 'analysis', type: 'result-analysis', createdBy: 'tool', createdAt: new Date().toISOString(), data: {}, metadata: { modelId: 'carbon', jobId: 'job-1' } },
  ]
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/messages')) return response([{ id: 'm1', role: 'user', content: 'Run carbon model' }])
    if (url.endsWith('/confirmations')) return response([])
    if (url.endsWith('/events') && init?.method === 'POST') {
      return response({ id: 1, type: 'event', data: {} }, 201)
    }
    if (url.endsWith('/checkpoint')) {
      const body = JSON.parse(String(init?.body))
      checkpoints.push(body)
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

    await worker.runOnce()
    // checkpoints[0] = 'start' (no domain_state), checkpoints[1] = 'complete'
    const complete = checkpoints.find(c => c.action === 'complete')
    // Phase should be reset to discovering-data, not stuck at results-analyzed
    assert.equal((complete?.domain_state as Record<string, unknown>)?.phase, 'discovering-data')
    // The persisted ledger is append-only (includes superseded for audit), so
    // assert on the ACTIVE set — what gates/finish actually see on resume.
    const ledger = complete?.artifacts as Array<{ type: string; superseded?: boolean }> | undefined
    const remaining = ledger?.filter(a => !a.superseded)
    // Matching artifacts preserved
    assert.ok(remaining?.some(a => a.type === 'model-input-schema'), 'schema preserved')
    // Execution artifacts cleared from the active set
    for (const type of ['model-job', 'job-status', 'validation-report', 'confirmation-record', 'result-analysis']) {
      assert.equal(remaining?.some(a => a.type === type), false, `${type} should be cleared`)
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('worker answers a general question without resetting phase or exposing GSMS tools', async () => {
  const checkpoints: Array<Record<string, unknown>> = []
  const current = session()
  current.domain_state = {
    sceneId: 'scene-1',
    modelId: 'carbon',
    matchingContextId: 'ctx-carbon',
    phase: 'results-analyzed',
  }
  current.artifacts = [
    { id: 'analysis', type: 'result-analysis', createdBy: 'tool', createdAt: new Date().toISOString(), data: {}, metadata: { modelId: 'carbon' } },
  ]
  const model = new FakeModelAdapter([
    {
      content: '',
      toolCalls: [{ id: '1', name: 'finish', input: { summary: '1+1=2', evidence: ['arithmetic'] } }],
    },
  ])
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('status=queued')) return response([current])
    if (url.endsWith('/messages')) return response([{ id: 'm1', role: 'user', content: '1+1=?' }])
    if (url.endsWith('/confirmations')) return response([])
    if (url.endsWith('/events') && init?.method === 'POST') {
      return response({ id: 1, type: 'event', data: {} }, 201)
    }
    if (url.endsWith('/checkpoint')) {
      const body = JSON.parse(String(init?.body))
      checkpoints.push(body)
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
      modelFactory: () => model,
    })

    assert.equal(await worker.runOnce(), true)
    const visibleToolNames = model.requests[0]?.tools.map(tool => tool.name) ?? []
    assert.deepEqual(visibleToolNames.sort(), ['finish', 'update_goal'])
    assert.equal(visibleToolNames.includes('get_invest_model_schema'), false)
    const complete = checkpoints.find(c => c.action === 'complete')
    assert.equal((complete?.domain_state as Record<string, unknown>)?.phase, 'results-analyzed')
    assert.equal((complete?.artifacts as unknown[] | undefined)?.length, 1)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
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

test('phase filter: matching group tools gated by evidence', () => {
  assert.equal(isExecutionPhase('ready-for-validation'), false)
  assert.equal(isExecutionPhase('job-running'), true)

  const tools = new ToolRegistry([
    stubTool('finish'),
    stubTool('get_invest_model_schema'),
    stubTool('list_scene_data_cards'),
    stubTool('discover_data_hub_candidates'),
    stubTool('import_data_hub_files_to_scene'),
    stubTool('retrieve_input_candidates'),
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
      data: { modelId: 'carbon', displayName: 'Carbon', version: '3.19.0', slots: [] },
      metadata: { modelId: 'carbon' },
    },
    {
      type: 'gsms-scene-data-cards',
      createdBy: 'tool',
      data: {},
      metadata: { sceneId: 'scene-1', modelId: 'carbon' },
    },
    {
      type: 'candidate-set',
      createdBy: 'tool',
      data: {},
      metadata: { slot: 'lulc_bas' },
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
  const filter = workflowPhaseFilter()

  const visibleTools = tools.list().filter(tool => filter(tool, context)).map(tool => tool.name)
  // In matching group, all domain tools are visible (gates enforce quality inside tools)
  assert.ok(visibleTools.includes('get_invest_model_schema'), 'schema tool visible')
  assert.ok(visibleTools.includes('list_scene_data_cards'), 'data cards tool visible')
  assert.ok(visibleTools.includes('discover_data_hub_candidates'), 'data hub discovery visible')
  assert.ok(visibleTools.includes('import_data_hub_files_to_scene'), 'data hub import visible')
  assert.ok(visibleTools.includes('retrieve_input_candidates'), 'candidates tool visible')
  assert.ok(visibleTools.includes('finalize_data_matching'), 'finalize visible')
  assert.ok(visibleTools.includes('validate_binding_report'), 'validation visible')
  assert.ok(visibleTools.includes('confirm_validation_snapshot'), 'confirmation visible (gate inside tool)')
  assert.ok(visibleTools.includes('execute_validated_snapshot'), 'execution visible (gate inside tool)')
  assert.ok(visibleTools.includes('finish'), 'finish visible when evidence exists')
})

test('workflow phase policy drives execution gate and resume instructions', () => {
  assert.equal(WAITING_PHASES.has('ready-for-validation'), true)
  assert.equal(executionPhaseAllows('interpret_invest_results', 'results-analyzed'), true)
  assert.equal(executionPhaseAllows('analyze_invest_results', 'results-analyzed'), false)
  assert.match(
    phaseResumeInstruction('results-analyzed', 'carbon') ?? '',
    /Call interpret_invest_results directly/,
  )
})

test('phase filter blocks finish for empty single-model scene before data hub discovery', () => {
  const tools = new ToolRegistry([
    stubTool('finish'),
    stubTool('discover_data_hub_candidates'),
    stubTool('retrieve_required_input_candidates'),
    stubTool('retrieve_input_candidates'),
    stubTool('assess_scene_model_readiness'),
    stubTool('finalize_sufficiency_assessment'),
    stubTool('list_scene_data_cards'),
    stubTool('get_invest_model_schema'),
  ])
  const finish = tools.list().find(tool => tool.name === 'finish')!
  const discover = tools.list().find(tool => tool.name === 'discover_data_hub_candidates')!
  const retrieveRequired = tools.list().find(tool => tool.name === 'retrieve_required_input_candidates')!
  const retrieveOne = tools.list().find(tool => tool.name === 'retrieve_input_candidates')!
  const readiness = tools.list().find(tool => tool.name === 'assess_scene_model_readiness')!
  const sufficiency = tools.list().find(tool => tool.name === 'finalize_sufficiency_assessment')!
  const dataCards = tools.list().find(tool => tool.name === 'list_scene_data_cards')!
  const schema = tools.list().find(tool => tool.name === 'get_invest_model_schema')!
  const makeContext = (artifacts: ArtifactStore) =>
    ({
      workspace: process.cwd(),
      goal: {
        objective: 'can carbon run',
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
        phase: 'discovering-data',
      }),
    }) satisfies AgentContext
  const emptyScene = new ArtifactStore()
  emptyScene.createMany([
    {
      type: 'model-input-schema',
      createdBy: 'tool',
      data: { modelId: 'carbon', displayName: 'Carbon', version: '3.19.0', slots: [] },
      metadata: { modelId: 'carbon' },
    },
    {
      type: 'gsms-scene-data-cards',
      createdBy: 'tool',
      data: { data_cards: [] },
      metadata: { sceneId: 'scene-1', modelId: 'carbon' },
    },
  ])
  const filter = workflowPhaseFilter()

  assert.equal(filter(finish, makeContext(emptyScene)), false)
  assert.equal(filter(discover, makeContext(emptyScene)), true)
  assert.equal(filter(retrieveRequired, makeContext(emptyScene)), false)
  assert.equal(filter(retrieveOne, makeContext(emptyScene)), false)
  assert.equal(filter(readiness, makeContext(emptyScene)), false)
  assert.equal(filter(sufficiency, makeContext(emptyScene)), false)
  assert.equal(filter(dataCards, makeContext(emptyScene)), true)
  assert.equal(filter(schema, makeContext(emptyScene)), true)

  emptyScene.create({
    type: 'data-hub-import-proposal',
    createdBy: 'tool',
    data: { slots: [], missing_slots: ['lulc_bas_path'] },
    metadata: { sceneId: 'scene-1', modelId: 'carbon' },
  })
  assert.equal(filter(finish, makeContext(emptyScene)), true)
  assert.equal(filter(retrieveRequired, makeContext(emptyScene)), true)
  assert.equal(filter(readiness, makeContext(emptyScene)), true)
})

test('phase filter uses mutation policy to require refreshed facts before finish', () => {
  const mutateTool: AgentTool = {
    name: 'publish_scene_dataset',
    description: 'test mutation',
    risk: 'write',
    inputSchema: { type: 'object' },
    policy: { mutation: { refreshesArtifacts: ['scene-dataset-list'] } },
    async execute() {
      return { content: 'ok' }
    },
  }
  const finish = stubTool('finish')
  const artifacts = new ArtifactStore()
  artifacts.createMany([
    {
      type: 'model-input-schema',
      createdBy: 'tool',
      data: { modelId: 'carbon', displayName: 'Carbon', version: '3.19.0', slots: [] },
      metadata: { modelId: 'carbon' },
    },
    {
      type: 'mutation-record',
      createdBy: 'user',
      data: {},
      metadata: { mutationTool: 'publish_scene_dataset', modelId: 'carbon' },
    },
  ])
  const context = {
    workspace: process.cwd(),
    goal: {
      objective: 'refresh facts',
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
      phase: 'discovering-data',
    }),
  } satisfies AgentContext
  const filter = workflowPhaseFilter([finish, mutateTool])

  assert.equal(filter(finish, context), false)

  artifacts.create({
    type: 'scene-dataset-list',
    createdBy: 'tool',
    data: { datasets: ['dataset-1'] },
    metadata: { refreshedAfterMutation: true, modelId: 'carbon' },
  })
  assert.equal(filter(finish, context), true)
})

test('phase filter enforces hard gate in execution phase', () => {
  const artifacts = new ArtifactStore()
  artifacts.createMany([
    {
      type: 'model-input-schema',
      createdBy: 'tool',
      data: { modelId: 'carbon', displayName: 'Carbon', version: '3.19.0', slots: [] },
      metadata: { modelId: 'carbon' },
    },
  ])
  const context = {
    workspace: process.cwd(),
    goal: {
      objective: 'check status',
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
      phase: 'job-running',
    }),
  } satisfies AgentContext
  const filter = workflowPhaseFilter()

  assert.equal(filter(stubTool('get_invest_job_status'), context), true, 'polling allowed during job-running')
  assert.equal(filter(stubTool('inspect_invest_job_outputs'), context), false, 'inspect blocked during job-running')
  assert.equal(filter(stubTool('finalize_data_matching'), context), false, 'matching blocked during execution')
  assert.equal(filter(stubTool('validate_binding_report'), context), false, 'validation blocked during execution')
})

test('phase filter hides forward tools while a binding is needs_review', () => {
  const makeContext = (state: Record<string, unknown>) =>
    ({
      workspace: process.cwd(),
      goal: {
        objective: 'run carbon', status: 'active' as const, turnCount: 1, maxTurns: 10,
        evidence: [], remainingIssues: [], startedAt: new Date().toISOString(),
      },
      artifacts: new ArtifactStore(),
      domainState: new DomainStateStore(state),
    }) satisfies AgentContext
  const filter = workflowPhaseFilter()

  const blocked = makeContext({ modelId: 'carbon', matchingContextId: 'ctx-carbon', phase: 'resolving-ambiguity', bindingStatus: 'needs_review' })
  assert.equal(filter(stubTool('validate_binding_report'), blocked), false, 'validate hidden while ambiguous')
  assert.equal(filter(stubTool('confirm_validation_snapshot'), blocked), false, 'confirm hidden while ambiguous')
  assert.equal(filter(stubTool('finalize_sufficiency_assessment'), blocked), false, 'sufficiency hidden while ambiguous')
  // Tools needed to resolve the ambiguity stay available
  assert.equal(filter(stubTool('finalize_data_matching'), blocked), true, 're-finalize stays available')
  assert.equal(filter(stubTool('retrieve_input_candidates'), blocked), true, 'candidate retrieval stays available')
  assert.equal(filter(stubTool('check_data_relation'), blocked), true, 'relation check stays available')

  // Once resolved (ready-for-validation), the forward tools come back
  const ready = makeContext({ modelId: 'carbon', matchingContextId: 'ctx-carbon', phase: 'ready-for-validation', bindingStatus: 'ready_for_validation' })
  assert.equal(filter(stubTool('validate_binding_report'), ready), true, 'validate visible once ready')
  assert.equal(filter(stubTool('finalize_sufficiency_assessment'), ready), true, 'sufficiency visible once ready')
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
