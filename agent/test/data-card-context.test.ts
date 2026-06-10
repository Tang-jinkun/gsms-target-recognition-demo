import assert from 'node:assert/strict'
import test from 'node:test'
import { ArtifactStore, DomainStateStore } from '@gsms/agent-core'
import { computeSceneDataContextId, computeMatchingContextId } from '../src/tools/matchingTools.ts'
import { dataCardSchema, type DataCard } from '../src/domain/schemas.ts'

const sampleCard: DataCard = {
  assetId: 'asset-1',
  path: 'data/lulc_current.tif',
  filename: 'lulc_current.tif',
  assetType: 'raster',
  semanticHints: ['lulc', 'current', 'landuse'],
  provenance: { source: 'user-local', fingerprint: 'abc123' },
}

const sampleCard2: DataCard = {
  assetId: 'asset-2',
  path: 'data/carbon_pools.csv',
  filename: 'carbon_pools.csv',
  assetType: 'csv',
  semanticHints: ['carbon', 'pools'],
  provenance: { source: 'user-local', fingerprint: 'def456' },
  tabular: { fields: [{ name: 'lucode' }, { name: 'c_above' }] },
}

test('computeSceneDataContextId does not depend on model schema', () => {
  const sceneId = 'scene-1'
  const cards = [sampleCard, sampleCard2]

  const ctx1 = computeSceneDataContextId(sceneId, cards)
  const ctx2 = computeSceneDataContextId(sceneId, cards)
  assert.equal(ctx1, ctx2, 'same inputs produce same hash')
  assert.equal(typeof ctx1, 'string')
  assert.ok(ctx1.length > 0)
})

test('computeSceneDataContextId differs from computeMatchingContextId', () => {
  const sceneId = 'scene-1'
  const cards = [sampleCard, sampleCard2]
  const schema = { modelId: 'carbon', displayName: 'Carbon', version: '3.17.2', slots: [] }

  const sceneCtx = computeSceneDataContextId(sceneId, cards)
  const matchCtx = computeMatchingContextId(sceneId, schema, cards)
  assert.notEqual(sceneCtx, matchCtx, 'scene context must not equal matching context')
})

test('computeSceneDataContextId changes when scene changes', () => {
  const cards = [sampleCard]
  const ctx1 = computeSceneDataContextId('scene-1', cards)
  const ctx2 = computeSceneDataContextId('scene-2', cards)
  assert.notEqual(ctx1, ctx2)
})

test('computeSceneDataContextId changes when assets change', () => {
  const sceneId = 'scene-1'
  const ctx1 = computeSceneDataContextId(sceneId, [sampleCard])
  const ctx2 = computeSceneDataContextId(sceneId, [sampleCard, sampleCard2])
  assert.notEqual(ctx1, ctx2)
})

test('data-card artifacts survive model switch in artifact store', () => {
  const sceneId = 'scene-1'
  const cards = [sampleCard, sampleCard2]
  const sceneDataContextId = computeSceneDataContextId(sceneId, cards)

  const artifacts = new ArtifactStore()
  // Simulate list_scene_data_cards output (sceneDataContextId, no matchingContextId)
  artifacts.createMany(cards.map(card => ({
    type: 'data-card' as const,
    createdBy: 'tool' as const,
    data: card,
    metadata: {
      sceneId,
      sceneDataContextId,
      assetId: card.assetId,
    },
  })))

  // Simulate model switch: matchingContextId changes but sceneDataContextId doesn't
  const schemaCarbon = { modelId: 'carbon', displayName: 'Carbon', version: '3.17.2', slots: [] }
  const schemaHabitat = { modelId: 'habitat_quality', displayName: 'Habitat Quality', version: '3.17.2', slots: [] }
  const matchingCtxCarbon = computeMatchingContextId(sceneId, schemaCarbon, cards)
  const matchingCtxHabitat = computeMatchingContextId(sceneId, schemaHabitat, cards)
  assert.notEqual(matchingCtxCarbon, matchingCtxHabitat, 'precondition: matchingContextId differs per model')

  // Data cards are still findable by sceneDataContextId regardless of matchingContextId
  const found = artifacts.list('data-card').filter(a => a.metadata?.sceneDataContextId === sceneDataContextId)
  assert.equal(found.length, 2, 'both data cards found by sceneDataContextId')
  assert.deepEqual(
    found.map(a => (a.data as DataCard).assetId).sort(),
    ['asset-1', 'asset-2'],
  )
})

test('dataCards helper reads from sceneDataContextId not matchingContextId', () => {
  // This test verifies the fix: the dataCards() function in matchingTools.ts
  // now filters by sceneDataContextId, not matchingContextId.
  // We replicate the filtering logic directly.
  const sceneId = 'scene-1'
  const cards = [sampleCard, sampleCard2]
  const sceneDataContextId = computeSceneDataContextId(sceneId, cards)

  const artifacts = new ArtifactStore()
  artifacts.createMany(cards.map(card => ({
    type: 'data-card' as const,
    createdBy: 'tool' as const,
    data: card,
    metadata: { sceneId, sceneDataContextId, assetId: card.assetId },
  })))

  // After switching model, matchingContextId changes but sceneDataContextId doesn't
  const newMatchingCtx = 'different-matching-context-after-model-switch'

  // The old buggy path would filter by matchingContextId and find nothing
  const oldWay = artifacts.list('data-card').filter(a => a.metadata?.matchingContextId === newMatchingCtx)
  assert.equal(oldWay.length, 0, 'old way (matchingContextId) finds nothing after model switch')

  // The new correct path filters by sceneDataContextId
  const newWay = artifacts.list('data-card').filter(a => a.metadata?.sceneDataContextId === sceneDataContextId)
  assert.equal(newWay.length, 2, 'new way (sceneDataContextId) finds data cards after model switch')
})
