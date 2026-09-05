import type { ProtectedArtifactMetadataStore, ProtectedArtifactRecord } from './types.js'

export class MemoryProtectedArtifactMetadataStore implements ProtectedArtifactMetadataStore {
  readonly #records = new Map<string, ProtectedArtifactRecord>()

  create(record: ProtectedArtifactRecord): Promise<void> {
    if (this.#records.has(record.artifactId)) throw new Error('Artifact metadata already exists.')
    this.#records.set(record.artifactId, record)
    return Promise.resolve()
  }

  find(input: {
    readonly artifactId: string
    readonly organizationId: string
    readonly projectId: string
  }): Promise<ProtectedArtifactRecord | undefined> {
    const record = this.#records.get(input.artifactId)
    if (record?.organizationId !== input.organizationId || record.projectId !== input.projectId) {
      return Promise.resolve(undefined)
    }
    return Promise.resolve(record)
  }

  findExpired(limit: number, now: Date): Promise<readonly ProtectedArtifactRecord[]> {
    return Promise.resolve(
      [...this.#records.values()]
        .filter(
          (record) =>
            record.deletedAt === null &&
            record.deleteAfter !== null &&
            record.deleteAfter.getTime() <= now.getTime(),
        )
        .sort((left, right) =>
          left.deleteAfter === null || right.deleteAfter === null
            ? 0
            : left.deleteAfter.getTime() - right.deleteAfter.getTime(),
        )
        .slice(0, limit),
    )
  }

  markDeleted(input: {
    readonly artifactId: string
    readonly organizationId: string
    readonly projectId: string
    readonly deletedAt: Date
  }): Promise<void> {
    const record = this.#records.get(input.artifactId)
    if (
      record === undefined ||
      record.organizationId !== input.organizationId ||
      record.projectId !== input.projectId
    ) {
      throw new Error('Artifact metadata is unavailable in the requested scope.')
    }
    this.#records.set(input.artifactId, { ...record, deletedAt: input.deletedAt })
    return Promise.resolve()
  }
}
