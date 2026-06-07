import assert from 'node:assert/strict'
import test from 'node:test'
import { ArtifactStore } from '@gsms/agent-core'
import { MatchingWorkspace, retrieveCandidates } from '../src/index.ts'
import { carbonFields, csv, raster, testCarbonSlot } from './fixtures.ts'

test('matching workspace stores typed artifacts for later agent inspection', () => {
  const artifacts = new ArtifactStore()
  const workspace = new MatchingWorkspace(artifacts)
  const lulc = raster('lulc-current', 'lulc_current.tif', ['current land cover'], [1, 2])
  const pools = csv('carbon-pools', 'carbon_pools.csv', carbonFields)

  workspace.addDataCards([lulc, pools])
  workspace.addCandidateSet(retrieveCandidates(testCarbonSlot('lulc_bas_path'), workspace.dataCards()))
  workspace.addRelationCheck({
    id: 'code-coverage:lulc-current:carbon-pools:lucode',
    kind: 'code-coverage',
    leftAssetId: 'lulc-current',
    rightAssetId: 'carbon-pools',
    status: 'passed',
    facts: ['GSMS relation check passed'],
  })

  assert.equal(artifacts.list('data-card').length, 2)
  assert.equal(artifacts.list('candidate-set').length, 1)
  assert.equal(artifacts.list('relation-check').length, 1)
})
