import assert from 'node:assert/strict'
import test from 'node:test'
import { ArtifactStore, DomainStateStore } from '../src/index.ts'

test('artifact store creates immutable snapshots and filters by type', () => {
  const store = new ArtifactStore()
  const source = { fields: ['id'] }
  const artifact = store.create({
    id: 'record-card',
    type: 'data-card',
    createdBy: 'tool',
    data: source,
  })

  source.fields.push('name')
  artifact.data.fields.push('status')

  assert.deepEqual(store.get<{ fields: string[] }>('record-card')?.data.fields, ['id'])
  assert.equal(store.list('data-card').length, 1)
  assert.equal(store.list('decision-report').length, 0)
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
    phase: 'reviewing-inputs',
    items: {
      primary: { status: 'unresolved', candidates: [] },
      secondary: { status: 'unresolved' },
    },
  })

  store.applyPatch({
    phase: 'inputs-reviewed',
    items: {
      primary: { status: 'resolved', candidates: ['asset-1'] },
      secondary: null,
    },
  })

  assert.deepEqual(store.snapshot(), {
    phase: 'inputs-reviewed',
    items: {
      primary: { status: 'resolved', candidates: ['asset-1'] },
    },
  })
})
