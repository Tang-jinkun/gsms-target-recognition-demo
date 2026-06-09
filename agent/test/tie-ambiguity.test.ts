import assert from 'node:assert/strict'
import test from 'node:test'
import { ArtifactStore, DomainStateStore, type AgentContext, type GoalState } from '@gsms/agent-core'
import { GsmsClient, createGsmsTools, createMatchingTools, retrieveCandidates } from '../src/index.ts'
import { checkDataMatchingGate, hasTopScoreTie } from '../src/gates/dataMatchingGate.ts'
import type { BindingReport } from '../src/domain/schemas.ts'
import { carbonFields, csv, raster, testCarbonModelSchema, testCarbonSlot } from './fixtures.ts'

// ── hasTopScoreTie (pure) ──────────────────────────────────────────────────────

test('hasTopScoreTie: undefined / single / distinct → false, equal top → true', () => {
  const set = (cands: Array<{ assetId: string; score: number; rejected?: boolean }>) => ({
    slot: 'lulc_bas_path',
    candidates: cands.map(c => ({ assetId: c.assetId, score: c.score, evidence: [], rejected: c.rejected ?? false, rejectionReasons: [] })),
  })

  assert.equal(hasTopScoreTie(undefined), false)
  assert.equal(hasTopScoreTie(set([{ assetId: 'a', score: 0.9 }])), false)
  assert.equal(hasTopScoreTie(set([{ assetId: 'a', score: 0.9 }, { assetId: 'b', score: 0.4 }])), false)
  assert.equal(hasTopScoreTie(set([{ assetId: 'a', score: 0.5 }, { assetId: 'b', score: 0.5 }])), true)
  // A tied top loser that is rejected does not count
  assert.equal(hasTopScoreTie(set([{ assetId: 'a', score: 0.5 }, { assetId: 'b', score: 0.5, rejected: true }])), false)
})

// ── Gate: authoritative tie-break guard ─────────────────────────────────────────

function gateContext(): AgentContext {
  const goal: GoalState = {
    objective: 'match carbon', status: 'active', turnCount: 1, maxTurns: 10,
    evidence: [], remainingIssues: [], startedAt: new Date().toISOString(),
  }
  const artifacts = new ArtifactStore()
  artifacts.create({ type: 'model-input-schema', createdBy: 'tool', data: testCarbonModelSchema, metadata: { modelId: 'carbon' } })
  const cards = [
    raster('lulc-a', 'lulc_a.tif', ['current land cover'], [1, 2]),
    raster('lulc-b', 'lulc_b.tif', ['current land cover'], [1, 2]),
    csv('carbon-pools', 'carbon_pools.csv', carbonFields),
  ]
  for (const card of cards) {
    artifacts.create({ type: 'data-card', createdBy: 'tool', data: card, metadata: { sceneDataContextId: 'sdc-1' } })
  }
  artifacts.create({
    id: 'candidate-set:ctx-carbon:lulc_bas_path', type: 'candidate-set', createdBy: 'tool',
    data: retrieveCandidates(testCarbonSlot('lulc_bas_path'), cards),
    metadata: { modelId: 'carbon', matchingContextId: 'ctx-carbon', slot: 'lulc_bas_path' },
  })
  artifacts.create({
    id: 'candidate-set:ctx-carbon:carbon_pools_path', type: 'candidate-set', createdBy: 'tool',
    data: retrieveCandidates(testCarbonSlot('carbon_pools_path'), cards),
    metadata: { modelId: 'carbon', matchingContextId: 'ctx-carbon', slot: 'carbon_pools_path' },
  })
  artifacts.create({
    type: 'relation-check', createdBy: 'tool',
    data: { id: 'code-coverage:lulc-a:carbon-pools:lucode', kind: 'code-coverage', leftAssetId: 'lulc-a', rightAssetId: 'carbon-pools', status: 'passed', facts: ['ok'] },
    metadata: { modelId: 'carbon', matchingContextId: 'ctx-carbon' },
  })
  return {
    workspace: process.cwd(), goal, artifacts,
    domainState: new DomainStateStore({ sceneId: 'scene-1', modelId: 'carbon', matchingContextId: 'ctx-carbon', sceneDataContextId: 'sdc-1', phase: 'matching-slots' }),
  }
}

function tiedReport(overrides: { lulcUserConfirmed?: boolean } = {}): BindingReport {
  return {
    taskSpecId: 'matching:ctx-carbon', modelSchemaId: 'carbon:3.19.0',
    bindings: [
      { slot: 'lulc_bas_path', selectedAssetId: 'lulc-a', candidateAssetIds: ['lulc-a', 'lulc-b'], confidence: 0.5, status: 'matched', facts: [], agentReasoning: 'picked a', userConfirmed: overrides.lulcUserConfirmed },
      { slot: 'carbon_pools_path', selectedAssetId: 'carbon-pools', candidateAssetIds: ['carbon-pools'], confidence: 0.9, status: 'matched', facts: [], agentReasoning: 'only pools' },
    ],
    relationChecks: [{ id: 'code-coverage:lulc-a:carbon-pools:lucode', kind: 'code-coverage', leftAssetId: 'lulc-a', rightAssetId: 'carbon-pools', status: 'passed', facts: ['ok'] }],
    conflicts: [], unresolvedQuestions: [], recommendedNextAction: 'proceed-to-validation',
  }
}

test('gate forces needs_review when a required slot claims matched on a top-score tie', () => {
  const result = checkDataMatchingGate(gateContext(), tiedReport())
  assert.equal(result.status, 'needs_review')
  assert.equal(result.passed, false)
  assert.ok(result.blockingReasons.some(r => /equally-scored/.test(r)), `reasons: ${result.blockingReasons.join(' | ')}`)
})

test('gate trusts a tie-broken match when userConfirmed is set', () => {
  const result = checkDataMatchingGate(gateContext(), tiedReport({ lulcUserConfirmed: true }))
  assert.equal(result.status, 'ready_for_validation')
  assert.equal(result.passed, true)
})

// ── finalize_data_matching mirrors the override ─────────────────────────────────

function finalizeContext(): AgentContext {
  const goal: GoalState = {
    objective: 'match carbon', status: 'active', turnCount: 1, maxTurns: 10,
    evidence: [], remainingIssues: [], startedAt: new Date().toISOString(),
  }
  const artifacts = new ArtifactStore()
  artifacts.create({ type: 'model-input-schema', createdBy: 'tool', data: testCarbonModelSchema, metadata: { modelId: 'carbon' } })
  const cards = [
    raster('lulc-a', 'lulc_a.tif', ['current land cover'], [1, 2]),
    raster('lulc-b', 'lulc_b.tif', ['current land cover'], [1, 2]),
    csv('carbon-pools', 'carbon_pools.csv', carbonFields),
  ]
  artifacts.create({
    id: 'candidate-set:ctx-carbon:lulc_bas_path', type: 'candidate-set', createdBy: 'tool',
    data: retrieveCandidates(testCarbonSlot('lulc_bas_path'), cards),
    metadata: { modelId: 'carbon', matchingContextId: 'ctx-carbon', slot: 'lulc_bas_path' },
  })
  artifacts.create({
    id: 'candidate-set:ctx-carbon:carbon_pools_path', type: 'candidate-set', createdBy: 'tool',
    data: retrieveCandidates(testCarbonSlot('carbon_pools_path'), cards),
    metadata: { modelId: 'carbon', matchingContextId: 'ctx-carbon', slot: 'carbon_pools_path' },
  })
  return {
    workspace: process.cwd(), goal, artifacts,
    domainState: new DomainStateStore({ sceneId: 'scene-1', modelId: 'carbon', matchingContextId: 'ctx-carbon', phase: 'matching-slots' }),
  }
}

test('finalize_data_matching forces a tied required slot to ambiguous', async () => {
  const ctx = finalizeContext()
  const tool = createMatchingTools().find(t => t.name === 'finalize_data_matching')!
  const result = await tool.execute({
    modelId: 'carbon',
    decisions: [
      { slot: 'lulc_bas_path', selectedAssetId: 'lulc-a', status: 'matched', confidence: 0.5, reasoning: 'picked a' },
      { slot: 'carbon_pools_path', selectedAssetId: 'carbon-pools', status: 'matched', confidence: 0.9, reasoning: 'only pools' },
    ],
  }, ctx)

  const parsed = JSON.parse(result.content)
  const lulc = parsed.bindingReport.bindings.find((b: { slot: string }) => b.slot === 'lulc_bas_path')
  assert.equal(lulc.status, 'ambiguous')
  assert.equal(lulc.selectedAssetId, undefined)
  assert.equal(parsed.recommendedNextAction, 'request-user-input')
})

test('finalize_data_matching trusts a tied required slot when userConfirmed is set', async () => {
  const ctx = finalizeContext()
  // A passed relation check is required once lulc is a real match.
  ctx.artifacts.create({
    type: 'relation-check', createdBy: 'tool',
    data: { id: 'code-coverage:lulc-a:carbon-pools:lucode', kind: 'code-coverage', leftAssetId: 'lulc-a', rightAssetId: 'carbon-pools', status: 'passed', facts: ['ok'] },
    metadata: { modelId: 'carbon', matchingContextId: 'ctx-carbon' },
  })
  const tool = createMatchingTools().find(t => t.name === 'finalize_data_matching')!
  const result = await tool.execute({
    modelId: 'carbon',
    decisions: [
      { slot: 'lulc_bas_path', selectedAssetId: 'lulc-a', status: 'matched', confidence: 0.5, reasoning: 'user chose a', userConfirmed: true },
      { slot: 'carbon_pools_path', selectedAssetId: 'carbon-pools', status: 'matched', confidence: 0.9, reasoning: 'only pools' },
    ],
  }, ctx)

  const parsed = JSON.parse(result.content)
  const lulc = parsed.bindingReport.bindings.find((b: { slot: string }) => b.slot === 'lulc_bas_path')
  assert.equal(lulc.status, 'matched')
  assert.equal(lulc.selectedAssetId, 'lulc-a')
})

// ── validate_binding_report: gate-blocked guidance asks the user, not loop ───────

test('validate gate-blocked on ambiguity directs the agent to ask the user', async () => {
  let called = false
  const fetch = async () => { called = true; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }
  const goal: GoalState = {
    objective: 'run carbon', status: 'active', turnCount: 1, maxTurns: 10,
    evidence: [], remainingIssues: [], startedAt: new Date().toISOString(),
  }
  const artifacts = new ArtifactStore()
  artifacts.create({ type: 'model-input-schema', createdBy: 'tool', data: testCarbonModelSchema, metadata: { modelId: 'carbon' } })
  artifacts.create({
    type: 'binding-report', createdBy: 'agent',
    data: {
      taskSpecId: 'matching:ctx-carbon', modelSchemaId: 'carbon:3.19.0',
      bindings: [
        { slot: 'lulc_bas_path', candidateAssetIds: ['lulc-a', 'lulc-b'], confidence: 0.5, status: 'ambiguous', facts: [], agentReasoning: 'tie' },
        { slot: 'carbon_pools_path', candidateAssetIds: ['carbon-pools'], confidence: 0.9, status: 'matched', facts: [], agentReasoning: 'only pools' },
      ],
      relationChecks: [], conflicts: [], unresolvedQuestions: ['Which LULC raster?'], recommendedNextAction: 'request-user-input',
    },
    metadata: { modelId: 'carbon', matchingContextId: 'ctx-carbon', gatePassed: false, gateStatus: 'needs_review' },
  })
  const ctx: AgentContext = {
    workspace: process.cwd(), goal, artifacts,
    domainState: new DomainStateStore({ modelId: 'carbon', matchingContextId: 'ctx-carbon', phase: 'resolving-ambiguity' }),
  }
  const tool = createGsmsTools(new GsmsClient({ baseUrl: 'http://gsms', fetch })).find(t => t.name === 'validate_binding_report')!

  const result = await tool.execute({ modelId: 'carbon', sceneId: 'scene-1', parameters: {} }, ctx)
  const parsed = JSON.parse(result.content)

  assert.equal(called, false, 'backend validation must not be called while gate-blocked')
  assert.equal(parsed.status, 'gate-blocked')
  assert.deepEqual(parsed.ambiguousSlots, ['lulc_bas_path'])
  assert.match(result.hiddenMessages?.[0]?.content ?? '', /ask|choose|which one/i)
  assert.match(result.hiddenMessages?.[0]?.content ?? '', /Do NOT validate, confirm, or run sufficiency/)
})
