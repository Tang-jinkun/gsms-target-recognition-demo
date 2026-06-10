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

// ── Evidence Ledger ──────────────────────────────────────────────────────────

test('supersedes chain: same scope+type auto-supersedes previous', () => {
  const store = new ArtifactStore()
  store.currentScopeKey = 'turn:1'

  const a = store.create({ id: 'a', type: 'report', createdBy: 'tool', data: { v: 1 } })
  const b = store.create({ id: 'b', type: 'report', createdBy: 'tool', data: { v: 2 } })

  // Re-read from store — a should be marked superseded
  const aLive = store.get('a')!
  assert.equal(aLive.superseded, true)
  assert.equal(b.supersedes, 'a')
  assert.equal(b.superseded, false)

  // Default list excludes superseded
  assert.equal(store.list('report').length, 1)
  assert.equal(store.list('report')[0].id, 'b')

  // Include superseded shows both
  assert.equal(store.list('report', { includeSuperseded: true }).length, 2)
})

test('explicit supersedes marks target as superseded', () => {
  const store = new ArtifactStore()
  const a = store.create({ id: 'a', type: 'card', createdBy: 'tool', data: {} })
  const b = store.create({ id: 'b', type: 'card', createdBy: 'tool', data: {}, supersedes: 'a' })

  assert.equal(store.get('a')!.superseded, true)
  assert.equal(b.supersedes, 'a')
  assert.equal(store.list('card').length, 1)
})

test('scope filtering: list returns only matching scope', () => {
  const store = new ArtifactStore()

  store.currentScopeKey = 'turn:1'
  store.create({ id: 't1', type: 'data', createdBy: 'tool', data: {} })

  store.currentScopeKey = 'turn:2'
  store.create({ id: 't2', type: 'data', createdBy: 'tool', data: {} })

  assert.equal(store.list('data', { scopeKey: 'turn:1' }).length, 1)
  assert.equal(store.list('data', { scopeKey: 'turn:1' })[0].id, 't1')
  assert.equal(store.list('data', { scopeKey: 'turn:2' }).length, 1)
  assert.equal(store.list('data', { scopeKey: 'turn:2' })[0].id, 't2')
  // No scope filter returns all
  assert.equal(store.list('data').length, 2)
})

test('delete marks superseded instead of physically removing', () => {
  const store = new ArtifactStore()
  store.create({ id: 'x', type: 'item', createdBy: 'tool', data: {} })

  assert.equal(store.list('item').length, 1)
  store.delete('x')
  // Excluded from default list
  assert.equal(store.list('item').length, 0)
  // But still retrievable by ID
  assert.equal(store.get('x')!.superseded, true)
  // Visible with includeSuperseded
  assert.equal(store.list('item', { includeSuperseded: true }).length, 1)
})

test('different types in same scope do not supersede each other', () => {
  const store = new ArtifactStore()
  store.currentScopeKey = 'turn:1'

  store.create({ id: 'a1', type: 'alpha', createdBy: 'tool', data: {} })
  store.create({ id: 'b1', type: 'beta', createdBy: 'tool', data: {} })

  assert.equal(store.get('a1')!.superseded, false)
  assert.equal(store.list(undefined, { scopeKey: 'turn:1' }).length, 2)
})
