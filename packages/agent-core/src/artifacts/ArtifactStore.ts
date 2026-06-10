import { randomUUID } from 'node:crypto'
import type { Artifact, ArtifactInput } from '../types.ts'

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class ArtifactStore {
  readonly #artifacts = new Map<string, Artifact>()
  #currentScopeKey = ''

  /** Set by the runtime at the start of each turn. */
  set currentScopeKey(key: string) { this.#currentScopeKey = key }
  get currentScopeKey(): string { return this.#currentScopeKey }

  create<T>(input: ArtifactInput<T>): Artifact<T> {
    return this.createMany([input])[0] as Artifact<T>
  }

  createMany(inputs: readonly ArtifactInput[]): Artifact[] {
    // Phase 1: pre-compute IDs and validate no duplicates (batch-atomic).
    const resolved = inputs.map(input => ({ input, id: input.id ?? randomUUID() }))
    const seen = new Set<string>()
    for (const { id } of resolved) {
      if (seen.has(id) || this.#artifacts.has(id)) {
        throw new Error(`Duplicate artifact: ${id}`)
      }
      seen.add(id)
    }

    // Phase 2: create artifacts (supersedes chains resolved incrementally).
    const artifacts: Artifact[] = []
    for (const { input, id } of resolved) {
      const scopeKey = input.scopeKey ?? (this.#currentScopeKey || undefined)

      // ── Supersedes handling ──
      let supersedesId = input.supersedes

      // If no explicit supersedes, find the latest artifact with the same
      // scopeKey + type that is not already superseded.
      if (!supersedesId && scopeKey) {
        for (const existing of this.#artifacts.values()) {
          if (existing.scopeKey === scopeKey &&
              existing.type === input.type &&
              !existing.superseded) {
            supersedesId = existing.id
            break
          }
        }
      }

      // Mark the superseded artifact
      if (supersedesId) {
        const old = this.#artifacts.get(supersedesId)
        if (old) old.superseded = true
      }

      const artifact: Artifact = {
        id,
        type: input.type,
        version: input.version ?? 1,
        createdAt: input.createdAt ?? new Date().toISOString(),
        createdBy: input.createdBy,
        data: clone(input.data),
        metadata: input.metadata ? clone(input.metadata) : undefined,
        scopeKey,
        supersedes: supersedesId,
        superseded: false,
      }

      this.#artifacts.set(id, artifact)
      artifacts.push(artifact)
    }

    return artifacts.map(clone)
  }

  get<T = unknown>(id: string): Artifact<T> | undefined {
    const artifact = this.#artifacts.get(id)
    return artifact ? (clone(artifact) as Artifact<T>) : undefined
  }

  list(type?: string, options?: { scopeKey?: string; includeSuperseded?: boolean }): Artifact[] {
    const { scopeKey, includeSuperseded = false } = options ?? {}
    return [...this.#artifacts.values()]
      .filter(a => !type || a.type === type)
      .filter(a => !scopeKey || a.scopeKey === scopeKey)
      .filter(a => includeSuperseded || !a.superseded)
      .map(clone)
  }

  delete(id: string): boolean {
    const artifact = this.#artifacts.get(id)
    if (!artifact) return false
    // Append-only: mark as superseded instead of physically deleting.
    artifact.superseded = true
    return true
  }
}
