import assert from 'node:assert/strict'
import test from 'node:test'
import { ArtifactStore, DomainStateStore } from '../src/index.ts'

test('artifact store creates immutable snapshots and filters by type', () => {
  const store = new ArtifactStore()
  const source = { fields: ['lucode'] }
  const artifact = store.create({
    id: 'carbon-pools',
    type: 'data-card',
    createdBy: 'tool',
    data: source,
  })

  source.fields.push('c_above')
  artifact.data.fields.push('c_below')

  assert.deepEqual(store.get<{ fields: string[] }>('carbon-pools')?.data.fields, ['lucode'])
  assert.equal(store.list('data-card').length, 1)
  assert.equal(store.list('binding-report').length, 0)
})

test('artifact store rejects a duplicate batch without partially writing it', () => {
  const store = new ArtifactStore()

  assert.throws(
    () =>
      store.createMany([
        { id: 'same', type: 'a', createdBy: 'tool', data: {} },
        { id: 'same', type: 'b', createdBy: 'tool', data: {} },
      ]),
    /Duplicate artifact/,
  )
  assert.equal(store.list().length, 0)
})

test('domain state store applies nested merge patches and supports deletion', () => {
  const store = new DomainStateStore({
    phase: 'discovering-data',
    slots: {
      lulc: { status: 'unmatched', candidates: [] },
      carbonPools: { status: 'unmatched' },
    },
  })

  store.applyPatch({
    phase: 'matching-slots',
    slots: {
      lulc: { status: 'matched', candidates: ['asset-1'] },
      carbonPools: null,
    },
  })

  assert.deepEqual(store.snapshot(), {
    phase: 'matching-slots',
    slots: {
      lulc: { status: 'matched', candidates: ['asset-1'] },
    },
  })
})
