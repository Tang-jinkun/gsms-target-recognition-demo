import assert from 'node:assert/strict'
import test from 'node:test'
import { ArtifactStore, DomainStateStore, type AgentContext, type GoalState } from '@gsms/agent-core'
import {
  assertReportCanProceed,
  buildBindingReport,
  computeMatchingContextId,
  computeSceneDataContextId,
  createMatchingTools,
  retrieveCandidates,
} from '../src/index.ts'
import { carbonFields, csv, raster, testCarbonModelSchema, testCarbonSlot } from './fixtures.ts'

test('retrieves strong Carbon candidates without making a final binding', () => {
  const currentLulc = raster('lulc-current', 'lulc_current.tif', ['current land cover'], [1, 2])
  const pools = csv('carbon-pools', 'carbon_pools.csv', carbonFields)
  const candidates = retrieveCandidates(testCarbonSlot('lulc_bas_path'), [pools, currentLulc])

  assert.deepEqual(candidates.candidates.map(candidate => candidate.assetId), ['lulc-current'])
  assert.ok(candidates.candidates[0]!.score > 0.5)
  assert.equal('selectedAssetId' in candidates, false)
})

test('returns no candidates when a required Carbon input is missing', () => {
  const currentLulc = raster('lulc-current', 'lulc_current.tif', ['current land cover'], [1, 2])
  const candidates = retrieveCandidates(testCarbonSlot('carbon_pools_path'), [currentLulc])

  assert.deepEqual(candidates.candidates, [])
})

test('preserves multiple plausible LULC candidates for agent resolution', () => {
  const first = raster('lulc-a', 'lulc_current_a.tif', ['current land cover'], [1, 2])
  const second = raster('lulc-b', 'lulc_current_b.tif', ['current land cover'], [1, 2])
  const candidates = retrieveCandidates(testCarbonSlot('lulc_bas_path'), [first, second])

  assert.equal(candidates.candidates.length, 2)
  assert.equal(candidates.candidates[0]!.score, candidates.candidates[1]!.score)
})

test('candidate retrieval accepts legacy asset-id aliases for schema path slots', async () => {
  const currentLulc = raster('lulc-current', 'lulc_current.tif', ['current land cover'], [1, 2])
  const matchingContextId = computeMatchingContextId('scene-1', testCarbonModelSchema, [currentLulc])
  const artifacts = new ArtifactStore()
  artifacts.createMany([
    {
      type: 'model-input-schema',
      createdBy: 'tool',
      data: testCarbonModelSchema,
      metadata: { modelId: 'carbon' },
    },
    {
      type: 'data-card',
      createdBy: 'tool',
      data: currentLulc,
      metadata: { sceneId: 'scene-1', modelId: 'carbon', sceneDataContextId: 'scene-data-1', assetId: 'lulc-current' },
    },
  ])
  const context: AgentContext = {
    workspace: process.cwd(),
    goal: {
      objective: 'match carbon',
      status: 'active',
      turnCount: 1,
      maxTurns: 5,
      evidence: [],
      remainingIssues: [],
      startedAt: new Date().toISOString(),
    } satisfies GoalState,
    artifacts,
    domainState: new DomainStateStore({
      sceneId: 'scene-1',
      modelId: 'carbon',
      sceneDataContextId: 'scene-data-1',
      matchingContextId,
    }),
  }
  const tool = createMatchingTools().find(candidate => candidate.name === 'retrieve_input_candidates')!

  const result = await tool.execute({ slot: 'lulc_bas_asset_id' }, context)

  assert.equal(result.artifacts?.[0]?.type, 'candidate-set')
  assert.equal(result.artifacts?.[0]?.metadata?.slot, 'lulc_bas_path')
  assert.deepEqual((result.statePatch?.slots as Record<string, unknown>)?.lulc_bas_path, {
    candidateAssetIds: ['lulc-current'],
    status: 'candidates-found',
  })
})

test('candidate retrieval rejects scene data contexts that predate a Data Hub import', async () => {
  const currentLulc = raster('lulc-current', 'lulc_current.tif', ['current land cover'], [1, 2])
  const sceneDataContextId = computeSceneDataContextId('scene-1', [currentLulc])
  const matchingContextId = computeMatchingContextId('scene-1', testCarbonModelSchema, [currentLulc])
  const artifacts = new ArtifactStore()
  artifacts.createMany([
    {
      type: 'model-input-schema',
      createdBy: 'tool',
      data: testCarbonModelSchema,
      metadata: { modelId: 'carbon' },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      type: 'gsms-scene-data-cards',
      createdBy: 'tool',
      data: { data_cards: [currentLulc] },
      metadata: { sceneId: 'scene-1', modelId: 'carbon', sceneDataContextId },
      createdAt: '2026-01-01T00:00:01.000Z',
    },
    {
      type: 'data-card',
      createdBy: 'tool',
      data: currentLulc,
      metadata: { sceneId: 'scene-1', modelId: 'carbon', sceneDataContextId, assetId: 'lulc-current' },
      createdAt: '2026-01-01T00:00:01.000Z',
    },
    {
      type: 'scene-import-record',
      createdBy: 'user',
      data: {},
      metadata: { sceneId: 'scene-1', modelId: 'carbon', mutationTool: 'import_data_hub_files_to_scene' },
      createdAt: '2026-01-01T00:00:02.000Z',
    },
  ])
  const context: AgentContext = {
    workspace: process.cwd(),
    goal: {
      objective: 'match carbon',
      status: 'active',
      turnCount: 1,
      maxTurns: 5,
      evidence: [],
      remainingIssues: [],
      startedAt: new Date().toISOString(),
    } satisfies GoalState,
    artifacts,
    domainState: new DomainStateStore({
      sceneId: 'scene-1',
      modelId: 'carbon',
      sceneDataContextId,
      matchingContextId,
    }),
  }
  const tool = createMatchingTools().find(candidate => candidate.name === 'retrieve_input_candidates')!

  await assert.rejects(
    tool.execute({ slot: 'lulc_bas_path' }, context),
    /STALE_SCENE_DATA_CONTEXT/,
  )

  const finalizeTool = createMatchingTools().find(candidate => candidate.name === 'finalize_data_matching')!
  await assert.rejects(
    finalizeTool.execute({ modelId: 'carbon', decisions: [] }, context),
    /STALE_SCENE_DATA_CONTEXT/,
  )

  artifacts.create({
    type: 'gsms-scene-data-cards',
    createdBy: 'tool',
    data: { data_cards: [currentLulc] },
    metadata: {
      sceneId: 'scene-1',
      modelId: 'carbon',
      sceneDataContextId,
      refreshedAfterMutation: true,
      refreshedAfterImport: true,
    },
    createdAt: '2026-01-01T00:00:03.000Z',
  })
  artifacts.create({
    type: 'data-card',
    createdBy: 'tool',
    data: currentLulc,
    metadata: {
      sceneId: 'scene-1',
      modelId: 'carbon',
      sceneDataContextId,
      assetId: 'lulc-current',
      refreshedAfterMutation: true,
      refreshedAfterImport: true,
    },
    createdAt: '2026-01-01T00:00:03.000Z',
  })

  const result = await tool.execute({ slot: 'lulc_bas_path' }, context)
  assert.equal(result.artifacts?.[0]?.type, 'candidate-set')
  assert.deepEqual((result.statePatch?.slots as Record<string, { candidateAssetIds: string[] }>).lulc_bas_path.candidateAssetIds, ['lulc-current'])
})

test('matching context changes when current scene data provenance changes', () => {
  const first = raster('lulc-current', 'lulc_current.tif', ['current land cover'], [1, 2])
  const changed = { ...first, provenance: { ...first.provenance, fingerprint: 'changed-fingerprint' } }

  assert.notEqual(
    computeMatchingContextId('scene-1', testCarbonModelSchema, [first]),
    computeMatchingContextId('scene-1', testCarbonModelSchema, [changed]),
  )
})

test('binding report requires explicit reasoning and a next action', () => {
  assert.throws(
    () =>
      buildBindingReport({
        taskSpecId: 'task-1',
        modelSchemaId: 'carbon-3.17.2',
        bindings: [
          {
            slot: 'lulc_cur_path',
            candidateAssetIds: ['lulc-a', 'lulc-b'],
            confidence: 0.5,
            status: 'ambiguous',
            facts: [],
            agentReasoning: '',
          },
        ],
        relationChecks: [],
        conflicts: [],
        unresolvedQuestions: ['Which LULC represents the current scenario?'],
        recommendedNextAction: 'request-user-input',
      }),
    /Too small/,
  )
})

test('runtime guard blocks proceeding without required bindings and persisted checks', () => {
  const report = buildBindingReport({
    taskSpecId: 'task-1',
    modelSchemaId: 'carbon-3.17.2',
    bindings: [
      {
        slot: 'lulc_bas_path',
        selectedAssetId: 'lulc',
        candidateAssetIds: ['lulc'],
        confidence: 0.9,
        status: 'matched',
        facts: [],
        agentReasoning: 'Only current LULC candidate.',
      },
    ],
    relationChecks: [],
    conflicts: [],
    unresolvedQuestions: [],
    recommendedNextAction: 'proceed-to-validation',
  })

  assert.throws(
    () => assertReportCanProceed(report, testCarbonModelSchema, []),
    /Required slot is not matched: carbon_pools_path/,
  )
})

test('finalize matching requires candidate evidence for every required slot', async () => {
  const ctx = matchingContext()
  ctx.artifacts.create({
    id: 'candidate-set:old-context:carbon_pools_path',
    type: 'candidate-set',
    createdBy: 'tool',
    data: retrieveCandidates(testCarbonSlot('carbon_pools_path'), [
      csv('old-carbon-pools', 'old_carbon_pools.csv', carbonFields),
    ]),
    metadata: { modelId: 'carbon', matchingContextId: 'old-context', slot: 'carbon_pools_path' },
  })
  ctx.artifacts.create({
    id: 'candidate-set:ctx-carbon:lulc_bas_path',
    type: 'candidate-set',
    createdBy: 'tool',
    data: retrieveCandidates(testCarbonSlot('lulc_bas_path'), [
      raster('lulc-current', 'lulc_current.tif', ['current land cover'], [1, 2]),
    ]),
    metadata: { modelId: 'carbon', matchingContextId: 'ctx-carbon', slot: 'lulc_bas_path' },
  })
  const tool = createMatchingTools().find(candidate => candidate.name === 'finalize_data_matching')!

  await assert.rejects(
    tool.execute({
      modelId: 'carbon',
      decisions: [{
        slot: 'lulc_bas_path',
        selectedAssetId: 'lulc-current',
        status: 'matched',
        confidence: 0.9,
        reasoning: 'Only current LULC candidate.',
      }],
    }, ctx),
    /MATCHING_EVIDENCE_INCOMPLETE.*carbon_pools_path/,
  )
})

test('finalize matching rejects assets outside the persisted candidate set', async () => {
  const ctx = matchingContext()
  addRequiredCandidateSets(ctx)
  const tool = createMatchingTools().find(candidate => candidate.name === 'finalize_data_matching')!

  await assert.rejects(
    tool.execute({
      modelId: 'carbon',
      decisions: [
        {
          slot: 'lulc_bas_path',
          selectedAssetId: 'invented-lulc',
          status: 'matched',
          confidence: 0.9,
          reasoning: 'Invented candidate.',
        },
        {
          slot: 'carbon_pools_path',
          selectedAssetId: 'carbon-pools',
          status: 'matched',
          confidence: 0.9,
          reasoning: 'Only pools candidate.',
        },
      ],
    }, ctx),
    /SELECTED_ASSET_NOT_CANDIDATE/,
  )
})

function matchingContext(): AgentContext {
  const goal: GoalState = {
    objective: 'match carbon',
    status: 'active',
    turnCount: 1,
    maxTurns: 10,
    evidence: [],
    remainingIssues: [],
    startedAt: new Date().toISOString(),
  }
  const artifacts = new ArtifactStore()
  artifacts.create({
    type: 'model-input-schema',
    createdBy: 'tool',
    data: testCarbonModelSchema,
    metadata: { modelId: 'carbon' },
  })
  return {
    workspace: process.cwd(),
    goal,
    artifacts,
    domainState: new DomainStateStore({
      sceneId: 'scene-1',
      modelId: 'carbon',
      matchingContextId: 'ctx-carbon',
      phase: 'matching-slots',
    }),
  }
}

function addRequiredCandidateSets(ctx: AgentContext): void {
  const cards = [
    raster('lulc-current', 'lulc_current.tif', ['current land cover'], [1, 2]),
    csv('carbon-pools', 'carbon_pools.csv', carbonFields),
  ]
  for (const slot of testCarbonModelSchema.slots) {
    ctx.artifacts.create({
      id: `candidate-set:ctx-carbon:${slot.name}`,
      type: 'candidate-set',
      createdBy: 'tool',
      data: retrieveCandidates(slot, cards),
      metadata: { modelId: 'carbon', matchingContextId: 'ctx-carbon', slot: slot.name },
    })
  }
}
