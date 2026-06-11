import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dataImportProposalFromPayload } from '../confirmationPayload.ts'

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
    title: '导入外部数据',
    description: '确认后写入当前场景引用。',
    approveLabel: '导入',
    rejectLabel: '取消',
    allowPartial: false,
  })
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
  assert.equal(proposal?.selections[0]?.slot, 'carbon_pools_path')
  assert.equal(proposal?.selections[0]?.name, 'carbon_pools.csv')
})
