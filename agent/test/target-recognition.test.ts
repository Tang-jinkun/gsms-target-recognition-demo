import assert from 'node:assert/strict'
import test from 'node:test'
import { ArtifactStore, DomainStateStore, type AgentContext, type AgentTool, type GoalState } from '@gsms/agent-core'
import { buildTurnBoundary, createTargetRecognitionTools, workflowPhaseFilter } from '../src/index.ts'

function context(): AgentContext {
  const goal: GoalState = {
    objective: 'Find targets in the latest dataset',
    status: 'active',
    turnCount: 1,
    maxTurns: 10,
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

function apply(ctx: AgentContext, result: Awaited<ReturnType<ReturnType<typeof createTargetRecognitionTools>[number]['execute']>>) {
  const created = ctx.artifacts.createMany(result.artifacts ?? [])
  ctx.domainState.applyPatch(result.statePatch ?? {})
  return created
}

const profiles = {
  sceneId: 'scene-1',
  candidates: [
    vector('old', 'targets_2026-06-09.geojson', 'old-sha'),
    vector('latest', 'targets_2026-06-10.geojson', 'latest-sha'),
  ],
}

test('target workflow selects latest data, validates query, executes, and presents result', async () => {
  let analysisContextId = ''
  const client = {
    async listSceneVectorProfiles() {
      return profiles
    },
    async runTargetQuery(input: Record<string, unknown>) {
      return {
        ...input,
        analysisContextId,
        totalFeatureCount: 22,
        matchedFeatureCount: 8,
        invalidFeatureCount: 0,
        outputAsset: { id: 'result-asset', name: 'result.geojson' },
        outputFingerprint: 'result-sha',
      }
    },
    async publishGeneratedFile() {
      return { id: 'published-json' }
    },
  }
  const tools = createTargetRecognitionTools(client as never)
  const ctx = context()

  apply(ctx, await tool(tools, 'inspect_scene_vector_data').execute({ sceneId: 'scene-1' }, ctx))
  const selection = apply(ctx, await tool(tools, 'finalize_dataset_selection').execute({
    sceneId: 'scene-1',
    timeIntent: 'latest',
    candidates: [
      { assetId: 'old', interpretedDate: '2026-06-09', confidence: 0.99, reasoning: 'Filename date' },
      { assetId: 'latest', interpretedDate: '2026-06-10', confidence: 0.99, reasoning: 'Filename date' },
    ],
  }, ctx))[0]
  assert.deepEqual((selection.data as { selectedAssetIds: string[] }).selectedAssetIds, ['latest'])

  const query = apply(ctx, await tool(tools, 'finalize_target_query').execute({
    sceneId: 'scene-1',
    selectedAssetIds: ['latest'],
    targetDescription: 'waterlogging points',
    conditions: [{ field: 'point_type', operator: 'equals', value: '积水点' }],
    reasoning: 'The exact value is present in the current property profile.',
  }, ctx))[0]
  analysisContextId = (query.data as { analysisContextId: string }).analysisContextId

  const analysis = apply(ctx, await tool(tools, 'execute_target_query').execute({ artifactId: query.id }, ctx))[0]
  assert.equal((analysis.data as { matchedFeatureCount: number }).matchedFeatureCount, 8)

  const presentation = apply(ctx, await tool(tools, 'present_target_result').execute({ artifactId: analysis.id }, ctx))[0]
  assert.equal(presentation.type, 'map-presentation')
  assert.equal((presentation.data as { layers: Array<{ assetId: string }> }).layers[0]?.assetId, 'result-asset')
})

test('target query rejects values not supported by a complete property profile', async () => {
  const tools = createTargetRecognitionTools({ listSceneVectorProfiles: async () => profiles } as never)
  const ctx = context()
  apply(ctx, await tool(tools, 'inspect_scene_vector_data').execute({ sceneId: 'scene-1' }, ctx))
  apply(ctx, await tool(tools, 'finalize_dataset_selection').execute({
    sceneId: 'scene-1',
    timeIntent: 'latest',
    candidates: [
      { assetId: 'old', interpretedDate: '2026-06-09', confidence: 0.99, reasoning: 'Filename date' },
      { assetId: 'latest', interpretedDate: '2026-06-10', confidence: 0.99, reasoning: 'Filename date' },
    ],
  }, ctx))

  await assert.rejects(
    tool(tools, 'finalize_target_query').execute({
      sceneId: 'scene-1',
      selectedAssetIds: ['latest'],
      targetDescription: 'unsupported synonym',
      conditions: [{ field: 'point_type', operator: 'equals', value: 'flood' }],
      reasoning: 'Unsupported guess',
    }, ctx),
    /Values are not present/,
  )
})

test('target workflow can persist a blocking clarification instead of guessing', async () => {
  const tools = createTargetRecognitionTools({} as never)
  const ctx = context()
  const clarification = apply(ctx, await tool(tools, 'request_target_clarification').execute({
    sceneId: 'scene-1',
    question: 'Use the latest dataset, a specific date, or all data?',
    reason: 'The user did not provide a time scope.',
  }, ctx))[0]

  assert.equal(clarification.type, 'target-clarification')
  assert.equal(ctx.domainState.snapshot().phase, 'awaiting-target-clarification')

  const finish: AgentTool = {
    name: 'finish',
    description: 'finish',
    risk: 'control',
    inputSchema: { type: 'object' },
    async execute() { return { content: 'done' } },
  }
  assert.equal(workflowPhaseFilter([finish], buildTurnBoundary('execute-target-query'))(finish, ctx), true)
})

function vector(assetId: string, filename: string, sha256: string) {
  return {
    assetId,
    filename,
    fingerprint: { path: filename, size: 100, sha256 },
    profile: {
      feature_count: 10,
      geometry_types: { Point: 10 },
      fields: [{
        name: 'point_type',
        inferred_type: 'string',
        distinct_count: 2,
        sampled_values: ['积水点', '雨量站'],
        sampled_values_complete: true,
      }],
    },
  }
}

function tool(tools: ReturnType<typeof createTargetRecognitionTools>, name: string) {
  return tools.find(item => item.name === name)!
}
