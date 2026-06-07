import { randomUUID } from 'node:crypto'
import type { Artifact, ArtifactInput } from '../types.ts'

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class ArtifactStore {
  readonly #artifacts = new Map<string, Artifact>()

  create<T>(input: ArtifactInput<T>): Artifact<T> {
    return this.createMany([input])[0] as Artifact<T>
  }

  createMany(inputs: readonly ArtifactInput[]): Artifact[] {
    const artifacts = inputs.map(input => {
      const id = input.id ?? randomUUID()
      if (this.#artifacts.has(id)) throw new Error(`Duplicate artifact: ${id}`)
      return {
        id,
        type: input.type,
        version: input.version ?? 1,
        createdAt: input.createdAt ?? new Date().toISOString(),
        createdBy: input.createdBy,
        data: clone(input.data),
        metadata: input.metadata ? clone(input.metadata) : undefined,
      } satisfies Artifact
    })

    const ids = new Set<string>()
    for (const artifact of artifacts) {
      if (ids.has(artifact.id)) throw new Error(`Duplicate artifact: ${artifact.id}`)
      ids.add(artifact.id)
    }
    for (const artifact of artifacts) this.#artifacts.set(artifact.id, artifact)
    return artifacts.map(clone)
  }

  get<T = unknown>(id: string): Artifact<T> | undefined {
    const artifact = this.#artifacts.get(id)
    return artifact ? (clone(artifact) as Artifact<T>) : undefined
  }

  list(type?: string): Artifact[] {
    return [...this.#artifacts.values()]
      .filter(artifact => !type || artifact.type === type)
      .map(clone)
  }
}
