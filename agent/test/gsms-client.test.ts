import assert from 'node:assert/strict'
import test from 'node:test'
import { ArtifactStore, DomainStateStore, type AgentContext, type GoalState } from '@gsms/agent-core'
import { GsmsClient, createGsmsTools } from '../src/index.ts'
import { gsmsCarbonSchema } from './fixtures.ts'

function context(): AgentContext {
  const goal: GoalState = {
    objective: 'match data',
    status: 'active',
    turnCount: 1,
    maxTurns: 5,
    evidence: [],
    remainingIssues: [],
    startedAt: new Date().toISOString(),
  }
  return {
    workspace: process.cwd(),
    goal,
    artifacts: new ArtifactStore(),
    domainState: new DomainStateStore(),
  }
}

test('GSMS tools use backend schemas and data cards as authoritative artifacts', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init })
    const payload = url.endsWith('/schema')
      ? gsmsCarbonSchema
      : {
          scene_id: 'scene-1',
          data_cards: [
            {
              asset_id: 'lulc-1',
              path: 'lulc.tif',
              filename: 'lulc.tif',
              asset_type: 'raster',
              semantic_hints: ['current land cover'],
              metadata: { band_count: 1, width: 10, height: 10 },
              provenance: { size: 100 },
            },
          ],
          diagnostics: [],
        }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const client = new GsmsClient({ baseUrl: 'http://localhost:8000/', fetch })
  const tools = createGsmsTools(client)
  const ctx = context()

  const schemaResult = await tools
    .find(tool => tool.name === 'get_invest_model_schema')!
    .execute({ modelId: 'carbon' }, ctx)
  ctx.artifacts.createMany(schemaResult.artifacts ?? [])
  ctx.domainState.applyPatch(schemaResult.statePatch ?? {})
  const cardsResult = await tools
    .find(tool => tool.name === 'list_scene_data_cards')!
    .execute({ sceneId: 'scene-1' }, ctx)

  assert.equal(requests[0]?.url, 'http://localhost:8000/api/models/carbon/schema')
  assert.equal(requests[1]?.url, 'http://localhost:8000/api/scenes/scene-1/data-cards')
  assert.equal(schemaResult.artifacts?.[0]?.type, 'gsms-model-schema')
  assert.equal(schemaResult.artifacts?.[1]?.type, 'model-input-schema')
  assert.equal(
    (schemaResult.artifacts?.[1]?.data as { version: string }).version,
    '3.19.0',
  )
  assert.equal(cardsResult.artifacts?.[0]?.type, 'gsms-scene-data-cards')
  assert.equal(cardsResult.artifacts?.[1]?.type, 'data-card')
  assert.equal(cardsResult.artifacts?.[0]?.metadata?.refreshedAfterMutation, undefined)
})

test('list_scene_data_cards marks refreshed facts after a Data Hub import record', async () => {
  const fetch = async () => {
    return new Response(JSON.stringify({
      scene_id: 'scene-1',
      data_cards: [
        {
          asset_id: 'lulc-1',
          path: 'lulc.tif',
          filename: 'lulc.tif',
          asset_type: 'raster',
          semantic_hints: ['current land cover'],
          metadata: { band_count: 1, width: 10, height: 10 },
          provenance: { size: 100 },
        },
      ],
      diagnostics: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const tools = createGsmsTools(new GsmsClient({ baseUrl: 'http://localhost:8000/', fetch }))
  const ctx = context()
  ctx.artifacts.create({
    type: 'scene-import-record',
    createdBy: 'user',
    data: {},
    metadata: {
      sceneId: 'scene-1',
      modelId: 'carbon',
      mutationTool: 'import_data_hub_files_to_scene',
    },
  })

  const result = await tools
    .find(tool => tool.name === 'list_scene_data_cards')!
    .execute({ sceneId: 'scene-1' }, ctx)

  assert.equal(result.artifacts?.[0]?.metadata?.refreshedAfterMutation, true)
  assert.equal(result.artifacts?.[0]?.metadata?.refreshedAfterImport, true)
  assert.equal(result.artifacts?.[1]?.metadata?.refreshedAfterMutation, true)
})

test('GSMS relation tool sends a structured relation request', async () => {
  let body = ''
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    body = String(init?.body)
    return new Response(JSON.stringify({
      id: 'code-coverage:lulc-1:pools-1:lucode',
      kind: 'code-coverage',
      left_asset_id: 'lulc-1',
      right_asset_id: 'pools-1',
      status: 'passed',
      facts: ['Coverage passed'],
      missing_values: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'check_data_relation',
  )!
  const ctx = context()
  ctx.domainState.applyPatch({ modelId: 'carbon', matchingContextId: 'ctx-1', sceneId: 'scene-1' })
  await tool.execute(
    {
      kind: 'code-coverage',
      leftAssetId: 'lulc-1',
      rightAssetId: 'pools-1',
      field: 'lucode',
    },
    ctx,
  )

  assert.deepEqual(JSON.parse(body), {
    kind: 'code-coverage',
    left_asset_id: 'lulc-1',
    right_asset_id: 'pools-1',
    field: 'lucode',
  })
})

test('Data Hub discovery tool creates an import proposal artifact', async () => {
  let requestBody = ''
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body)
    return new Response(JSON.stringify({
      scene_id: 'scene-1',
      model_id: 'carbon',
      strategy: 'recommend-after-confirmation',
      slots: [
        {
          slot: 'lulc_bas_path',
          ambiguous: false,
          candidates: [
            {
              file_id: 'lulc-1',
              name: 'lulc_2020.tif',
              score: 0.82,
              confidence: 'high',
              reasons: ['File type raster matches the slot asset type.'],
              risks: [],
            },
          ],
        },
      ],
      recommended_file_ids: ['lulc-1'],
      missing_slots: [],
      ambiguous_slots: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'discover_data_hub_candidates',
  )!
  const ctx = context()
  ctx.domainState.applyPatch({ modelId: 'carbon' })

  const result = await tool.execute({ sceneId: 'scene-1', modelId: 'carbon' }, ctx)

  assert.deepEqual(JSON.parse(requestBody), {
    scene_id: 'scene-1',
    model_id: 'carbon',
    query: '',
    folder_id: null,
    study_area_bounds: null,
    limit_per_slot: 3,
  })
  assert.equal(result.artifacts?.[0]?.type, 'data-source-discovery-report')
  assert.equal(result.artifacts?.[0]?.metadata?.providerId, 'data-hub')
  assert.equal(result.artifacts?.[1]?.type, 'confirmation-proposal')
  assert.equal(result.artifacts?.[1]?.metadata?.actionTool, 'import_data_hub_files_to_scene')
  assert.equal(result.artifacts?.[2]?.type, 'data-hub-import-proposal')
  assert.deepEqual(result.statePatch?.dataHubRecommendedFileIds, ['lulc-1'])
  assert.equal(
    (result.artifacts?.[1]?.data as { selections: Array<{ fileId: string }> }).selections[0]?.fileId,
    'lulc-1',
  )
  assert.equal(result.artifacts?.[2]?.id, undefined)
})

test('Data Hub discovery proposal includes ambiguous candidates as importable options', async () => {
  const fetch = async () =>
    new Response(JSON.stringify({
      scene_id: 'scene-1',
      model_id: 'carbon',
      slots: [
        {
          slot: 'lulc_bas_path',
          ambiguous: true,
          candidates: [
            { file_id: 'lulc-current', name: 'lulc_current.tif', score: 0.54, confidence: 'low', reasons: [], risks: [] },
            { file_id: 'lulc-future', name: 'lulc_future.tif', score: 0.50, confidence: 'low', reasons: [], risks: [] },
          ],
        },
      ],
      recommended_file_ids: [],
      missing_slots: [],
      ambiguous_slots: ['lulc_bas_path'],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'discover_data_hub_candidates',
  )!
  const result = await tool.execute({ sceneId: 'scene-1', modelId: 'carbon' }, context())

  assert.deepEqual(result.statePatch?.dataHubRecommendedFileIds, [])
  assert.equal(result.statePatch?.phase, 'awaiting-data-import-confirmation')
  assert.deepEqual(result.artifacts?.[0]?.metadata?.proposedFileIds, ['lulc-current', 'lulc-future'])
  assert.equal(result.artifacts?.[0]?.type, 'data-source-discovery-report')
  assert.deepEqual(result.artifacts?.[1]?.metadata?.proposedFileIds, ['lulc-current', 'lulc-future'])
  assert.equal(result.artifacts?.[1]?.type, 'confirmation-proposal')
  assert.deepEqual(result.artifacts?.[2]?.metadata?.proposedFileIds, ['lulc-current', 'lulc-future'])
  assert.equal(
    (result.artifacts?.[1]?.data as { selections: Array<{ fileId: string }> }).selections[0]?.fileId,
    'lulc-current',
  )
  assert.match(result.hiddenMessages?.[0]?.content ?? '', /Call import_data_hub_files_to_scene now/)
  assert.match(result.hiddenMessages?.[0]?.content ?? '', /confirmation UI/)
})

test('Data Hub import tool requires proposal evidence and posts selected file IDs', async () => {
  const requests: Array<{ url: string; body: string }> = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, body: String(init?.body ?? '') })
    const payload = url.endsWith('/data-cards')
      ? {
          scene_id: 'scene-1',
          data_cards: [
            {
              asset_id: 'lulc-1',
              path: 'lulc_2020.tif',
              filename: 'lulc_2020.tif',
              asset_type: 'raster',
              semantic_hints: ['current land cover'],
              metadata: { band_count: 1, width: 10, height: 10 },
              provenance: { size: 100 },
            },
            {
              asset_id: 'pools-1',
              path: 'carbon_pools.csv',
              filename: 'carbon_pools.csv',
              asset_type: 'table',
              semantic_hints: ['carbon pools'],
              metadata: { columns: ['lucode', 'c_above', 'c_below', 'c_soil', 'c_dead'], sample_rows: [] },
              provenance: { size: 100 },
            },
          ],
          diagnostics: [],
        }
      : {
          scene_id: 'scene-1',
          imported: 2,
          skipped_existing: [],
          missing_file_ids: [],
          file_ids: ['lulc-1', 'pools-1'],
        }
    return new Response(JSON.stringify(payload), {
      status: url.endsWith('/data-cards') ? 200 : 201,
      headers: { 'content-type': 'application/json' },
    })
  }
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'import_data_hub_files_to_scene',
  )!
  assert.deepEqual(tool.policy?.mutation?.refreshesArtifacts, ['gsms-scene-data-cards', 'data-card'])
  const ui = tool.policy?.confirmation?.ui?.({
    sceneId: 'scene-1',
    fileIds: ['lulc-1', 'pools-1'],
    selections: [
      { slot: 'lulc_bas_path', fileId: 'lulc-1', name: 'lulc_2020.tif', score: 0.82, confidence: 'high', reasons: ['raster match'], risks: [] },
    ],
  }, {})
  assert.equal(ui?.type, 'data-import-proposal')
  assert.equal(Array.isArray(ui?.rows) && (ui.rows[0] as { fileId?: string } | undefined)?.fileId, 'lulc-1')
  const ctx = context()
  ctx.domainState.applyPatch({ sceneId: 'scene-1', modelId: 'carbon' })
  ctx.lastConsumedConfirmationId = 'confirmation-1'
  ctx.artifacts.create({
    type: 'confirmation-proposal',
    createdBy: 'tool',
    data: {
      kind: 'data-import-proposal',
      actionTool: 'import_data_hub_files_to_scene',
      slots: [
        {
          slot: 'lulc_bas_path',
          candidates: [{ file_id: 'lulc-1' }],
        },
        {
          slot: 'carbon_pools_path',
          candidates: [{ file_id: 'pools-1' }],
        },
      ],
    },
    metadata: {
      sceneId: 'scene-1',
      modelId: 'carbon',
      actionTool: 'import_data_hub_files_to_scene',
      recommendedFileIds: ['pools-1'],
      proposedFileIds: ['lulc-1', 'pools-1'],
    },
  })

  const result = await tool.execute({ sceneId: 'scene-1', fileIds: ['lulc-1', 'pools-1'] }, ctx)

  assert.deepEqual(JSON.parse(requests[0]!.body), {
    scene_id: 'scene-1',
    file_ids: ['lulc-1', 'pools-1'],
  })
  assert.equal(result.artifacts?.[0]?.type, 'scene-import-record')
  assert.equal(result.artifacts?.[0]?.createdBy, 'user')
  assert.equal(result.artifacts?.[1]?.type, 'gsms-scene-data-cards')
  assert.equal(result.artifacts?.filter(artifact => artifact.type === 'data-card').length, 2)
  assert.equal(result.statePatch?.phase, 'discovering-data')
  assert.deepEqual(result.statePatch?.assetIds, ['lulc-1', 'pools-1'])
  assert.match(result.hiddenMessages?.[0]?.content ?? '', /ignore any pre-import missing-data conclusion/)
})

test('Data Hub import tool rejects file IDs outside latest proposal', async () => {
  let called = false
  const fetch = async () => {
    called = true
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'import_data_hub_files_to_scene',
  )!
  const ctx = context()
  ctx.domainState.applyPatch({ sceneId: 'scene-1', modelId: 'carbon' })
  ctx.artifacts.create({
    type: 'data-hub-import-proposal',
    createdBy: 'tool',
    data: {},
    metadata: {
      sceneId: 'scene-1',
      modelId: 'carbon',
      recommendedFileIds: ['lulc-1'],
    },
  })

  await assert.rejects(
    tool.execute({ sceneId: 'scene-1', fileIds: ['other-1'] }, ctx),
    /not present in the latest Data Hub proposal/,
  )
  assert.equal(called, false)
})

test('Data Hub import tool fails if refreshed scene data remains empty', async () => {
  const fetch = async (input: string | URL | Request) => {
    const url = String(input)
    const payload = url.endsWith('/data-cards')
      ? { scene_id: 'scene-1', data_cards: [], diagnostics: [] }
      : { scene_id: 'scene-1', imported: 1, skipped_existing: [], missing_file_ids: [], file_ids: ['lulc-1'] }
    return new Response(JSON.stringify(payload), {
      status: url.endsWith('/data-cards') ? 200 : 201,
      headers: { 'content-type': 'application/json' },
    })
  }
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'import_data_hub_files_to_scene',
  )!
  const ctx = context()
  ctx.domainState.applyPatch({ sceneId: 'scene-1', modelId: 'carbon' })
  ctx.artifacts.create({
    type: 'data-hub-import-proposal',
    createdBy: 'tool',
    data: { slots: [{ slot: 'lulc_bas_path', candidates: [{ file_id: 'lulc-1' }] }] },
    metadata: { sceneId: 'scene-1', modelId: 'carbon', proposedFileIds: ['lulc-1'] },
  })

  await assert.rejects(
    tool.execute({ sceneId: 'scene-1', fileIds: ['lulc-1'] }, ctx),
    /did not produce scene data cards/,
  )
})

test('GSMS relation tool reuses identical persisted evidence without creating duplicates', async () => {
  let calls = 0
  const fetch = async () => {
    calls++
    return new Response(JSON.stringify({
      id: 'code-coverage:lulc-1:pools-1:lucode',
      kind: 'code-coverage',
      left_asset_id: 'lulc-1',
      right_asset_id: 'pools-1',
      status: 'passed',
      facts: ['Coverage passed'],
      missing_values: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'check_data_relation',
  )!
  const ctx = context()
  ctx.domainState.applyPatch({ modelId: 'carbon', matchingContextId: 'ctx-1', sceneId: 'scene-1' })

  const first = await tool.execute(
    { kind: 'code-coverage', leftAssetId: 'lulc-1', rightAssetId: 'pools-1', field: 'lucode' },
    ctx,
  )
  ctx.artifacts.createMany(first.artifacts ?? [])
  const second = await tool.execute(
    { kind: 'code-coverage', leftAssetId: 'lulc-1', rightAssetId: 'pools-1', field: 'lucode' },
    ctx,
  )

  assert.equal(calls, 2, 'the relation must still be freshly checked')
  assert.equal(second.artifacts, undefined)
  assert.equal(JSON.parse(second.content).evidence_reused, true)
  assert.match(second.hiddenMessages?.[0]?.content ?? '', /do not call check_data_relation again/)
  assert.equal(ctx.artifacts.list('relation-check').length, 1)
})

test('GSMS relation tool rejects changed results that conflict with persisted evidence', async () => {
  let calls = 0
  const fetch = async () => {
    calls++
    return new Response(JSON.stringify({
      id: 'code-coverage:lulc-1:pools-1:lucode',
      kind: 'code-coverage',
      left_asset_id: 'lulc-1',
      right_asset_id: 'pools-1',
      status: calls === 1 ? 'passed' : 'failed',
      facts: [calls === 1 ? 'Coverage passed' : 'Coverage failed'],
      missing_values: calls === 1 ? [] : [9],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'check_data_relation',
  )!
  const ctx = context()
  ctx.domainState.applyPatch({ modelId: 'carbon', matchingContextId: 'ctx-1', sceneId: 'scene-1' })
  const input = {
    kind: 'code-coverage',
    leftAssetId: 'lulc-1',
    rightAssetId: 'pools-1',
    field: 'lucode',
  }
  const first = await tool.execute(input, ctx)
  ctx.artifacts.createMany(first.artifacts ?? [])

  await assert.rejects(tool.execute(input, ctx), /result changed.*rebuild the binding evidence/)
})

test('adapts Habitat Quality asset inputs without model-specific Agent code', async () => {
  const fetch = async () =>
    new Response(
      JSON.stringify({
        id: 'habitat_quality',
        name: 'Habitat Quality',
        inputs: [
          {
            id: 'threats_table_asset_id',
            invest_arg: 'threats_table_path',
            label: 'Threats table',
            kind: 'asset',
            asset_type: 'table',
            required: true,
            required_fields: ['threat', 'max_dist', 'weight', 'decay', 'cur_path'],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'get_invest_model_schema',
  )!
  const result = await tool.execute({ modelId: 'habitat_quality' }, context())
  const adapted = result.artifacts?.find(artifact => artifact.type === 'model-input-schema')?.data as {
    slots: Array<{ name: string; requiredFields: string[] }>
  }

  assert.equal(adapted.slots[0]?.name, 'threats_table_path')
  assert.deepEqual(adapted.slots[0]?.requiredFields, [
    'threat',
    'max_dist',
    'weight',
    'decay',
    'cur_path',
  ])
})

test('validation tool submits the persisted Binding Report and exposes failed validation', async () => {
  let requestBody = ''
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body)
    return new Response(
      JSON.stringify({
        can_proceed: false,
        snapshot_id: 'failed-snapshot',
        validation: {
          status: 'error',
          errors: ['Carbon pools CSV is missing required columns'],
          warnings: [],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const ctx = context()
  ctx.domainState.applyPatch({ modelId: 'carbon' })
  ctx.artifacts.create({
    type: 'binding-report',
    createdBy: 'agent',
    data: { taskSpecId: 'task-1' },
    metadata: { modelId: 'carbon' },
  })
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'validate_binding_report',
  )!
  const result = await tool.execute(
    { modelId: 'carbon', sceneId: 'scene-1', parameters: { calc_sequestration: false } },
    ctx,
  )

  const sent = JSON.parse(requestBody)
  assert.deepEqual(sent.binding_report, { taskSpecId: 'task-1' })
  assert.equal(result.statePatch?.phase, 'validation-failed')
  assert.equal(result.artifacts?.[0]?.type, 'validation-report')
  assert.equal(result.diagnostics?.[0]?.severity, 'error')
  assert.match(result.hiddenMessages?.[0]?.content ?? '', /Do not repeat validation unchanged/)
})

test('selecting a different model resets stale matching and execution state', async () => {
  const fetch = async () =>
    new Response(JSON.stringify(gsmsCarbonSchema), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const ctx = context()
  ctx.domainState.applyPatch({
    modelId: 'habitat_quality',
    phase: 'ready-for-validation',
    slots: { lulc_cur_path: { status: 'matched' } },
    validationSnapshotId: 'old-snapshot',
    jobId: 'old-job',
  })
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'get_invest_model_schema',
  )!

  const result = await tool.execute({ modelId: 'carbon' }, ctx)
  ctx.domainState.applyPatch(result.statePatch ?? {})
  const state = ctx.domainState.snapshot()

  assert.equal(state.modelId, 'carbon')
  assert.equal(state.phase, 'discovering-data')
  assert.equal(state.slots, undefined)
  assert.equal(state.validationSnapshotId, undefined)
  assert.equal(state.jobId, undefined)
})

test('validation rejects a model different from the selected model', async () => {
  let called = false
  const fetch = async () => {
    called = true
    return new Response('{}', { status: 200 })
  }
  const ctx = context()
  ctx.domainState.applyPatch({ modelId: 'habitat_quality' })
  ctx.artifacts.create({
    type: 'binding-report',
    createdBy: 'agent',
    data: { taskSpecId: 'task-carbon' },
    metadata: { modelId: 'carbon' },
  })
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'validate_binding_report',
  )!

  await assert.rejects(
    tool.execute({ modelId: 'carbon', sceneId: 'scene-1', parameters: {} }, ctx),
    /does not match the selected model habitat_quality/,
  )
  assert.equal(called, false)
})

test('passed validation directs the agent to request confirmation and is not repeated', async () => {
  let calls = 0
  const fetch = async () => {
    calls++
    return new Response(JSON.stringify({
      can_proceed: true,
      snapshot_id: 'snapshot-carbon',
      validation: { status: 'ok', errors: [], warnings: [] },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const ctx = context()
  ctx.domainState.applyPatch({ modelId: 'carbon', phase: 'ready-for-validation' })
  ctx.artifacts.create({
    type: 'binding-report',
    createdBy: 'agent',
    data: { taskSpecId: 'task-carbon' },
    metadata: { modelId: 'carbon' },
  })
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'validate_binding_report',
  )!

  const first = await tool.execute({ modelId: 'carbon', sceneId: 'scene-1', parameters: {} }, ctx)
  ctx.domainState.applyPatch(first.statePatch ?? {})
  const second = await tool.execute({ modelId: 'carbon', sceneId: 'scene-1', parameters: {} }, ctx)

  assert.equal(calls, 1)
  assert.equal(first.statePatch?.phase, 'awaiting-user-confirmation')
  assert.match(first.hiddenMessages?.[0]?.content ?? '', /call confirm_validation_snapshot/)
  assert.match(second.content, /already-validated/)
  assert.match(second.hiddenMessages?.[0]?.content ?? '', /Do not validate again/)
})

test('execution tool refuses an unconfirmed validation snapshot before calling GSMS', async () => {
  let called = false
  const fetch = async () => {
    called = true
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const ctx = context()
  ctx.domainState.applyPatch({
    phase: 'awaiting-user-confirmation',
    validationSnapshotId: 'snapshot-1',
    validationStatus: 'passed',
  })
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'execute_validated_snapshot',
  )!

  await assert.rejects(
    tool.execute({ snapshotId: 'snapshot-1', runMode: 'real' }, ctx),
    /No confirmation record found/,
  )
  assert.equal(called, false)
})

test('confirmation and execution tools use the exact current snapshot', async () => {
  const requests: string[] = []
  const fetch = async (input: string | URL | Request) => {
    requests.push(String(input))
    const payload = String(input).endsWith('/confirm')
      ? { snapshot_id: 'snapshot-1', status: 'confirmed' }
      : { job_id: 'job-1', status: 'running' }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const tools = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch }))
  const ctx = context()
  ctx.domainState.applyPatch({
    phase: 'awaiting-user-confirmation',
    validationSnapshotId: 'snapshot-1',
    matchingContextId: 'test-matching-ctx',
  })
  // The tool now gates on validation-report artifact, not phase
  ctx.artifacts.create({
    type: 'validation-report',
    createdBy: 'tool',
    data: { can_proceed: true, snapshot_id: 'snapshot-1' },
    metadata: { matchingContextId: 'test-matching-ctx' },
  })
  const confirmation = await tools
    .find(candidate => candidate.name === 'confirm_validation_snapshot')!
    .execute({ snapshotId: 'snapshot-1', confirmed: true }, ctx)
  ctx.domainState.applyPatch(confirmation.statePatch ?? {})
  // In the real runtime, StreamingToolExecutor stores result artifacts.
  // In this direct-call test we must do it manually.
  if (confirmation.artifacts?.length) ctx.artifacts.createMany(confirmation.artifacts)
  const execution = await tools
    .find(candidate => candidate.name === 'execute_validated_snapshot')!
    .execute({ snapshotId: 'snapshot-1', runMode: 'real' }, ctx)

  assert.match(requests[0]!, /validation-snapshots\/snapshot-1\/confirm$/)
  assert.match(requests[1]!, /validation-snapshots\/snapshot-1\/jobs$/)
  assert.equal(execution.statePatch?.jobId, 'job-1')
})

test('job status, outputs, analysis, and interpretation tools enforce the current job workflow', async () => {
  const requests: string[] = []
  const fetch = async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/outputs')) {
      return new Response(JSON.stringify([{ name: 'result.tif', type: 'raster' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.endsWith('/logs')) {
      return new Response('=== job runner finished ===', { status: 200 })
    }
    if (url.endsWith('/analyze-results')) {
      return new Response(JSON.stringify({
        sceneId: 'scene-1',
        jobId: 'job-1',
        modelId: 'carbon',
        outputFingerprints: { 'result.tif': 'abc123' },
        rasters: [{ id: 'result.tif', role: 'unified', statistics: { validPixels: 100, total: 500 } }],
        comparisons: [],
        warnings: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ job_id: 'job-1', status: 'succeeded' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const tools = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch }))
  const ctx = context()
  ctx.domainState.applyPatch({
    phase: 'job-running',
    sceneId: 'scene-1',
    jobId: 'job-1',
    modelId: 'carbon',
  })

  const status = await tools
    .find(candidate => candidate.name === 'get_invest_job_status')!
    .execute({ sceneId: 'scene-1', jobId: 'job-1' }, ctx)
  ctx.artifacts.createMany(status.artifacts ?? [])
  ctx.domainState.applyPatch(status.statePatch ?? {})
  const outputs = await tools
    .find(candidate => candidate.name === 'inspect_invest_job_outputs')!
    .execute({ sceneId: 'scene-1', jobId: 'job-1' }, ctx)
  ctx.artifacts.createMany(outputs.artifacts ?? [])
  ctx.domainState.applyPatch(outputs.statePatch ?? {})
  const analysis = await tools
    .find(candidate => candidate.name === 'analyze_invest_results')!
    .execute({ sceneId: 'scene-1', jobId: 'job-1' }, ctx)
  ctx.artifacts.createMany(analysis.artifacts ?? [])
  ctx.domainState.applyPatch(analysis.statePatch ?? {})
  const interpretation = await tools
    .find(candidate => candidate.name === 'interpret_invest_results')!
    .execute({ sceneId: 'scene-1', jobId: 'job-1' }, ctx)

  assert.equal(status.statePatch?.phase, 'job-succeeded')
  assert.equal(outputs.statePatch?.phase, 'outputs-inspected')
  assert.equal(analysis.statePatch?.phase, 'results-analyzed')
  assert.equal(interpretation.statePatch?.phase, 'results-ready-for-interpretation')
  assert.equal(analysis.artifacts?.[0]?.type, 'result-analysis')
  assert.equal(interpretation.artifacts?.[0]?.type, 'result-interpretation-context')
  assert.match(requests[0]!, /scenes\/scene-1\/jobs\/job-1$/)
  assert.match(requests[1]!, /scenes\/scene-1\/jobs\/job-1\/outputs$/)
  assert.match(requests[2]!, /api\/data\/files\/generated$/)
  assert.match(requests[3]!, /scenes\/scene-1\/jobs\/job-1\/analyze-results$/)
  assert.match(requests[4]!, /api\/data\/files\/generated$/)
  assert.match(requests[5]!, /scenes\/scene-1\/jobs\/job-1\/logs$/)
  assert.match(requests[6]!, /api\/data\/files\/generated$/)
})

test('output inspection refuses a running job without calling GSMS', async () => {
  let called = false
  const fetch = async () => {
    called = true
    return new Response('[]', { status: 200 })
  }
  const ctx = context()
  ctx.domainState.applyPatch({
    phase: 'job-running',
    sceneId: 'scene-1',
    jobId: 'job-1',
    jobStatus: 'running',
  })
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(
    candidate => candidate.name === 'inspect_invest_job_outputs',
  )!

  await assert.rejects(
    tool.execute({ sceneId: 'scene-1', jobId: 'job-1' }, ctx),
    /only after the current job succeeds/,
  )
  assert.equal(called, false)
})
