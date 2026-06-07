import type { DomainState, DomainStatePatch } from '../types.ts'

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergePatch(target: DomainState, patch: DomainStatePatch): DomainState {
  const result = clone(target)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key]
    } else if (isRecord(value) && isRecord(result[key])) {
      result[key] = mergePatch(result[key] as DomainState, value)
    } else {
      result[key] = clone(value)
    }
  }
  return result
}

export class DomainStateStore {
  #state: DomainState

  constructor(initialState: DomainState = {}) {
    this.#state = clone(initialState)
  }

  snapshot<T extends DomainState = DomainState>(): T {
    return clone(this.#state) as T
  }

  applyPatch(patch: DomainStatePatch): DomainState {
    this.#state = mergePatch(this.#state, patch)
    return this.snapshot()
  }
}
