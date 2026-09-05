import { createHash } from 'node:crypto'

import type { ArtifactReferenceV1, ProviderRequestContextV1 } from '@platform/contracts'
import { PlatformError, type ArtifactReaderPort, type ArtifactStorePort } from '@platform/domain'

import {
  artifactRetentionClassSchema,
  protectedArtifactRecordSchema,
  type ArtifactRetentionClass,
  type PrivateBlobClient,
  type ProtectedArtifactMetadataStore,
  type ProtectedArtifactRecord,
} from './types.js'

const RETENTION_MS: Readonly<Record<Exclude<ArtifactRetentionClass, 'pinned'>, number>> = {
  ephemeral: 24 * 60 * 60 * 1_000,
  benchmark: 7 * 24 * 60 * 60 * 1_000,
  standard: 30 * 24 * 60 * 60 * 1_000,
}

const SAFE_MEDIA_TYPES = new Set([
  'application/json',
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'image/png',
  'text/plain',
])

export interface ProtectedArtifactStoreOptions {
  readonly clock?: () => Date
  readonly maxObjectBytes?: number
}

export class ProtectedArtifactStore implements ArtifactStorePort, ArtifactReaderPort {
  readonly #blobs: PrivateBlobClient
  readonly #clock: () => Date
  readonly #maxObjectBytes: number
  readonly #metadata: ProtectedArtifactMetadataStore

  constructor(
    blobs: PrivateBlobClient,
    metadata: ProtectedArtifactMetadataStore,
    options: ProtectedArtifactStoreOptions = {},
  ) {
    this.#blobs = blobs
    this.#metadata = metadata
    this.#clock = options.clock ?? (() => new Date())
    this.#maxObjectBytes = options.maxObjectBytes ?? 16 * 1_024 * 1_024
    if (!Number.isSafeInteger(this.#maxObjectBytes) || this.#maxObjectBytes < 1_024) {
      throw new Error('Protected artifact size limit must be at least 1024 bytes.')
    }
  }

  async put(
    context: ProviderRequestContextV1,
    content: Uint8Array,
    metadata: {
      readonly artifactId?: string
      readonly mediaType: string
      readonly retentionClass: string
      readonly runId?: string
    },
  ): Promise<ArtifactReferenceV1> {
    if (!(content instanceof Uint8Array) || content.byteLength > this.#maxObjectBytes) {
      throw this.#error(context, 'Artifact exceeds the configured object-size limit.')
    }
    if (!SAFE_MEDIA_TYPES.has(metadata.mediaType)) {
      throw this.#error(context, 'Artifact media type is not permitted.')
    }
    const retentionClass = artifactRetentionClassSchema.safeParse(metadata.retentionClass)
    if (!retentionClass.success || metadata.runId === undefined) {
      throw this.#error(context, 'Artifact scope or retention metadata is invalid.')
    }
    const digest = createHash('sha256').update(content).digest('hex')
    const artifactId = metadata.artifactId ?? digestUuid(digest)
    const createdAt = this.#clock()
    const blobPath = pathFor(context, metadata.runId, artifactId)
    const record = protectedArtifactRecordSchema.parse({
      artifactId,
      organizationId: context.organizationId,
      projectId: context.projectId,
      runId: metadata.runId,
      blobPath,
      sha256: digest,
      sizeBytes: content.byteLength,
      mediaType: metadata.mediaType,
      createdAt,
      retentionClass: retentionClass.data,
      deleteAfter:
        retentionClass.data === 'pinned'
          ? null
          : new Date(createdAt.getTime() + RETENTION_MS[retentionClass.data]),
      createdBy: context.actorRef,
      deletedAt: null,
    })
    await this.#blobs.put({ content, mediaType: record.mediaType, path: record.blobPath })
    try {
      await this.#metadata.create(record)
    } catch (error) {
      await this.#blobs.delete(record.blobPath).catch(() => undefined)
      throw error
    }
    return referenceFor(record)
  }

  async read(
    context: ProviderRequestContextV1,
    reference: ArtifactReferenceV1,
  ): Promise<Uint8Array> {
    const record = await this.#authorizedRecord(context, reference)
    const content = await this.#blobs.get(record.blobPath)
    if (content === undefined || content.byteLength !== record.sizeBytes) {
      throw this.#error(context, 'Artifact content is unavailable or has an invalid size.')
    }
    const digest = createHash('sha256').update(content).digest('hex')
    if (digest !== record.sha256 || digest !== reference.digest) {
      throw this.#error(context, 'Artifact integrity verification failed.')
    }
    return content
  }

  async delete(context: ProviderRequestContextV1, reference: ArtifactReferenceV1): Promise<void> {
    const record = await this.#authorizedRecord(context, reference)
    await this.#blobs.delete(record.blobPath)
    await this.#metadata.markDeleted({
      artifactId: record.artifactId,
      organizationId: record.organizationId,
      projectId: record.projectId,
      deletedAt: this.#clock(),
    })
  }

  async collectExpired(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Artifact GC batch limit must be between 1 and 1000.')
    }
    const now = this.#clock()
    const expired = await this.#metadata.findExpired(limit, now)
    for (const record of expired) {
      if (record.retentionClass === 'pinned' || record.deletedAt !== null) continue
      await this.#blobs.delete(record.blobPath)
      await this.#metadata.markDeleted({
        artifactId: record.artifactId,
        organizationId: record.organizationId,
        projectId: record.projectId,
        deletedAt: now,
      })
    }
    return expired.filter(
      (record) => record.retentionClass !== 'pinned' && record.deletedAt === null,
    ).length
  }

  async #authorizedRecord(
    context: ProviderRequestContextV1,
    reference: ArtifactReferenceV1,
  ): Promise<ProtectedArtifactRecord> {
    const artifactId = parseArtifactUri(reference.uri)
    const record = await this.#metadata.find({
      artifactId,
      organizationId: context.organizationId,
      projectId: context.projectId,
    })
    if (
      record === undefined ||
      record.deletedAt !== null ||
      record.sha256 !== reference.digest ||
      record.mediaType !== reference.mediaType ||
      record.retentionClass !== reference.retentionClass
    ) {
      throw this.#error(context, 'Artifact is not available in the authorized project scope.')
    }
    return record
  }

  #error(context: ProviderRequestContextV1, safeMessage: string) {
    return new PlatformError({
      code: 'VALIDATION_FAILED',
      correlationId: context.correlationId,
      retryable: false,
      safeMessage,
    })
  }
}

function pathFor(context: ProviderRequestContextV1, runId: string, artifactId: string) {
  return `tenants/${context.organizationId}/projects/${context.projectId}/runs/${runId}/artifacts/${artifactId}`
}

function referenceFor(record: ProtectedArtifactRecord): ArtifactReferenceV1 {
  return {
    schemaVersion: '1',
    uri: `protected-artifact://${record.artifactId}`,
    digest: record.sha256,
    mediaType: record.mediaType,
    retentionClass: record.retentionClass,
  }
}

function parseArtifactUri(uri: string) {
  const match = /^protected-artifact:\/\/([0-9a-f-]{36})$/u.exec(uri)
  if (match?.[1] === undefined) throw new Error('Protected artifact reference is invalid.')
  return match[1]
}

function digestUuid(digest: string) {
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}
