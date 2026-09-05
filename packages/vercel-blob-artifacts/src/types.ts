import { z } from 'zod'

const opaqueId = z.string().uuid()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)

export const artifactRetentionClassSchema = z.enum(['ephemeral', 'benchmark', 'standard', 'pinned'])

export const protectedArtifactRecordSchema = z
  .object({
    artifactId: opaqueId,
    organizationId: opaqueId,
    projectId: opaqueId,
    runId: opaqueId,
    blobPath: z.string().min(1).max(1024),
    sha256,
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string().min(1).max(160),
    createdAt: z.date(),
    retentionClass: artifactRetentionClassSchema,
    deleteAfter: z.date().nullable(),
    createdBy: z.string().regex(/^(?:user|service):[0-9a-f-]{36}$/u),
    deletedAt: z.date().nullable(),
  })
  .strict()

export type ArtifactRetentionClass = z.infer<typeof artifactRetentionClassSchema>
export type ProtectedArtifactRecord = z.infer<typeof protectedArtifactRecordSchema>

export interface ProtectedArtifactMetadataStore {
  create(record: ProtectedArtifactRecord): Promise<void>
  find(input: {
    readonly artifactId: string
    readonly organizationId: string
    readonly projectId: string
  }): Promise<ProtectedArtifactRecord | undefined>
  findExpired(limit: number, now: Date): Promise<readonly ProtectedArtifactRecord[]>
  markDeleted(input: {
    readonly artifactId: string
    readonly organizationId: string
    readonly projectId: string
    readonly deletedAt: Date
  }): Promise<void>
}

export interface PrivateBlobClient {
  delete(path: string): Promise<void>
  get(path: string): Promise<Uint8Array | undefined>
  put(input: {
    readonly content: Uint8Array
    readonly mediaType: string
    readonly path: string
  }): Promise<void>
}
