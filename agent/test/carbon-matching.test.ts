import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertReportCanProceed,
  buildBindingReport,
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
