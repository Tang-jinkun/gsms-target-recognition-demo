import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDataHubImportConfirmationOverride, dataImportProposalFromPayload } from '../confirmationPayload.ts'

test('data import proposal renders from generic confirmation ui contract without tool-name coupling', () => {
  const proposal = dataImportProposalFromPayload('publish_external_dataset', {
    ui: {
      type: 'data-import-proposal',
      title: '导入外部数据',
      description: '确认后写入当前场景引用。',
      fileIds: ['lulc-1'],
      rows: [{
        id: 'lulc-1',
        fileId: 'lulc-1',
        slot: 'lulc_bas_path',
        label: 'lulc_current.tif',
        confidence: 'medium',
        score: 0.54,
        reasons: ['name matches lulc/current'],
        risks: [],
      }],
      actions: {
        approveLabel: '导入',
        rejectLabel: '取消',
        allowPartial: false,
      },
    },
  })

  assert.deepEqual(proposal, {
    fileIds: ['lulc-1'],
    selections: [{
      slot: 'lulc_bas_path',
      fileId: 'lulc-1',
      name: 'lulc_current.tif',
      confidence: 'medium',
      score: 0.54,
      reasons: ['name matches lulc/current'],
      risks: [],
    }],
    slots: [],
    title: '导入外部数据',
    description: '确认后写入当前场景引用。',
    approveLabel: '导入',
    rejectLabel: '取消',
    allowPartial: false,
  })
})

test('data import proposal separates default selected ids from selectable candidate rows', () => {
  const proposal = dataImportProposalFromPayload('import_data_hub_files_to_scene', {
    ui: {
      type: 'data-import-proposal',
      fileIds: ['pools-1'],
      slots: [
        {
          slot: 'carbon_pools_path',
          label: 'Carbon pools table',
          required: true,
          status: 'auto_selected',
          selectedFileId: 'pools-1',
          candidates: [
            { fileId: 'pools-1', slot: 'carbon_pools_path', name: 'carbon_pools.csv', recommended: true, required: true },
          ],
        },
        {
          slot: 'lulc_bas_path',
          label: 'Baseline LULC raster',
          required: true,
          status: 'needs_user_choice',
          candidates: [
            { fileId: 'lulc-current', slot: 'lulc_bas_path', name: 'lulc_current.tif', ambiguous: true, required: true },
            { fileId: 'lulc-future', slot: 'lulc_bas_path', name: 'lulc_future.tif', ambiguous: true, required: true },
          ],
        },
      ],
      rows: [
        { fileId: 'pools-1', slot: 'carbon_pools_path', label: 'carbon_pools.csv', recommended: true, required: true },
        { fileId: 'lulc-current', slot: 'lulc_bas_path', label: 'lulc_current.tif', ambiguous: true, required: true },
        { fileId: 'lulc-future', slot: 'lulc_bas_path', label: 'lulc_future.tif', ambiguous: true, required: true },
      ],
      actions: { approveLabel: '导入所选', rejectLabel: '取消', allowPartial: true },
    },
  })

  assert.deepEqual(proposal?.fileIds, ['pools-1'])
  assert.deepEqual(proposal?.selections.map(selection => selection.fileId), ['pools-1', 'lulc-current', 'lulc-future'])
  assert.equal(proposal?.selections[0]?.recommended, true)
  assert.equal(proposal?.selections[1]?.ambiguous, true)
  assert.equal(proposal?.selections[1]?.required, true)
  assert.equal(proposal?.slots[0]?.status, 'auto_selected')
  assert.equal(proposal?.slots[0]?.selectedFileId, 'pools-1')
  assert.equal(proposal?.slots[1]?.status, 'needs_user_choice')
  assert.deepEqual(proposal?.slots[1]?.candidates.map(candidate => candidate.fileId), ['lulc-current', 'lulc-future'])
})

test('data import proposal keeps legacy Data Hub payload fallback', () => {
  const proposal = dataImportProposalFromPayload('import_data_hub_files_to_scene', {
    summary: {
      fileIds: ['pools-1'],
      selections: [{
        slot: 'carbon_pools_path',
        fileId: 'pools-1',
        name: 'carbon_pools.csv',
        confidence: 'high',
        score: 0.93,
        reasons: ['required columns present'],
        risks: [],
      }],
    },
  })

  assert.equal(proposal?.fileIds[0], 'pools-1')
  assert.deepEqual(proposal?.slots, [])
  assert.equal(proposal?.selections[0]?.slot, 'carbon_pools_path')
  assert.equal(proposal?.selections[0]?.name, 'carbon_pools.csv')
})

test('data hub confirmation override includes auto imports plus the chosen ambiguous slot only', () => {
  const proposal = dataImportProposalFromPayload('import_data_hub_files_to_scene', {
    input: {
      sceneId: 'scene-1',
      fileIds: ['pools-1'],
    },
    authorizationKey: 'stale-original-key',
    ui: {
      type: 'data-import-proposal',
      fileIds: ['pools-1'],
      slots: [
        {
          slot: 'lulc_bas_path',
          label: 'Baseline LULC raster',
          required: true,
          status: 'needs_user_choice',
          candidates: [
            { fileId: 'lulc-current', slot: 'lulc_bas_path', name: 'lulc_current.tif', ambiguous: true, required: true },
            { fileId: 'lulc-future', slot: 'lulc_bas_path', name: 'lulc_future.tif', ambiguous: true, required: true },
          ],
        },
        {
          slot: 'carbon_pools_path',
          label: 'Carbon pools table',
          required: true,
          status: 'auto_selected',
          selectedFileId: 'pools-1',
          candidates: [
            { fileId: 'pools-1', slot: 'carbon_pools_path', name: 'carbon_pools.csv', recommended: true, required: true },
          ],
        },
      ],
      rows: [
        { fileId: 'lulc-current', slot: 'lulc_bas_path', label: 'lulc_current.tif', ambiguous: true, required: true },
        { fileId: 'lulc-future', slot: 'lulc_bas_path', label: 'lulc_future.tif', ambiguous: true, required: true },
        { fileId: 'pools-1', slot: 'carbon_pools_path', label: 'carbon_pools.csv', recommended: true, required: true },
      ],
    },
  })

  assert.ok(proposal)
  const override = buildDataHubImportConfirmationOverride(
    {
      input: { sceneId: 'scene-1', fileIds: ['pools-1'] },
      authorizationKey: 'stale-original-key',
    },
    proposal,
    { lulc_bas_path: 'lulc-current' },
  )

  assert.deepEqual((override.input as { fileIds: string[] }).fileIds, ['pools-1', 'lulc-current'])
  assert.deepEqual(
    ((override.input as { selections: Array<{ fileId: string }> }).selections).map(row => row.fileId),
    ['pools-1', 'lulc-current'],
  )
  assert.equal(Object.prototype.hasOwnProperty.call(override, 'authorizationKey'), false)
})
