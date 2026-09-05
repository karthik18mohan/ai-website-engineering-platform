import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm'

import { protectedArtifacts, type PlatformDatabase } from '@platform/database'
import {
  protectedArtifactRecordSchema,
  type ProtectedArtifactMetadataStore,
  type ProtectedArtifactRecord,
} from '@platform/vercel-blob-artifacts'

export class PostgresProtectedArtifactMetadataStore implements ProtectedArtifactMetadataStore {
  constructor(private readonly database: PlatformDatabase) {}

  async create(record: ProtectedArtifactRecord): Promise<void> {
    const parsed = protectedArtifactRecordSchema.parse(record)
    await this.database.insert(protectedArtifacts).values(parsed)
  }

  async find(input: {
    readonly artifactId: string
    readonly organizationId: string
    readonly projectId: string
  }): Promise<ProtectedArtifactRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(protectedArtifacts)
      .where(
        and(
          eq(protectedArtifacts.artifactId, input.artifactId),
          eq(protectedArtifacts.organizationId, input.organizationId),
          eq(protectedArtifacts.projectId, input.projectId),
        ),
      )
      .limit(1)
    return row === undefined ? undefined : protectedArtifactRecordSchema.parse(row)
  }

  async findExpired(limit: number, now: Date): Promise<readonly ProtectedArtifactRecord[]> {
    const rows = await this.database
      .select()
      .from(protectedArtifacts)
      .where(
        and(
          isNull(protectedArtifacts.deletedAt),
          isNotNull(protectedArtifacts.deleteAfter),
          lte(protectedArtifacts.deleteAfter, now),
        ),
      )
      .orderBy(asc(protectedArtifacts.deleteAfter))
      .limit(limit)
    return rows.map((row) => protectedArtifactRecordSchema.parse(row))
  }

  async markDeleted(input: {
    readonly artifactId: string
    readonly organizationId: string
    readonly projectId: string
    readonly deletedAt: Date
  }): Promise<void> {
    const rows = await this.database
      .update(protectedArtifacts)
      .set({ deletedAt: input.deletedAt })
      .where(
        and(
          eq(protectedArtifacts.artifactId, input.artifactId),
          eq(protectedArtifacts.organizationId, input.organizationId),
          eq(protectedArtifacts.projectId, input.projectId),
          isNull(protectedArtifacts.deletedAt),
        ),
      )
      .returning({ artifactId: protectedArtifacts.artifactId })
    if (rows.length !== 1) throw new Error('Protected artifact deletion mark was not applied.')
  }
}
