import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultMigrationsFolder } from './migrate.js'

const organizationId = '00000000-0000-4000-8000-000000000801'
const projectId = '00000000-0000-4000-8000-000000000802'
const runId = '00000000-0000-4000-8000-000000000803'
const artifactId = '00000000-0000-4000-8000-000000000804'

describe('M08 protected artifact migration', () => {
  let database: PGlite

  beforeEach(async () => {
    database = new PGlite()
    await migrate(drizzle(database), { migrationsFolder: defaultMigrationsFolder })
    await seedRun(database)
  })

  afterEach(async () => database.close())

  it('enforces tenant/run path, retention, size, and immutable metadata', async () => {
    await insertArtifact(database, 'standard', "now() + interval '30 days'")
    await expect(
      database.query(`UPDATE protected_artifacts SET sha256 = $1 WHERE artifact_id = $2`, [
        'b'.repeat(64),
        artifactId,
      ]),
    ).rejects.toThrow(/immutable/u)
    await expect(
      database.query(
        `INSERT INTO protected_artifacts (
          artifact_id, organization_id, project_id, run_id, blob_path, sha256,
          size_bytes, media_type, retention_class, delete_after, created_by, created_at
        ) VALUES ('00000000-0000-4000-8000-000000000899', $1, $2, $3,
          'tenants/wrong/projects/wrong/runs/wrong/artifacts/wrong', $4, 1,
          'text/plain', 'standard', now() + interval '30 days', $5, now())`,
        [
          organizationId,
          projectId,
          runId,
          'a'.repeat(64),
          'service:00000000-0000-4000-8000-000000000805',
        ],
      ),
    ).rejects.toThrow()
  })

  it('allows exactly one deletion mark and requires pinned objects to have no expiry', async () => {
    await insertArtifact(database, 'pinned', 'NULL')
    await database.query(
      `UPDATE protected_artifacts SET deleted_at = now() WHERE artifact_id = $1`,
      [artifactId],
    )
    await expect(
      database.query(
        `UPDATE protected_artifacts SET deleted_at = now() + interval '1 second' WHERE artifact_id = $1`,
        [artifactId],
      ),
    ).rejects.toThrow(/immutable/u)
  })
})

async function insertArtifact(database: PGlite, retentionClass: string, deleteAfter: string) {
  return database.query(
    `INSERT INTO protected_artifacts (
      artifact_id, organization_id, project_id, run_id, blob_path, sha256,
      size_bytes, media_type, retention_class, delete_after, created_by, created_at
    ) VALUES ($1, $2, $3, $4,
      'tenants/' || $2::uuid::text || '/projects/' || $3::uuid::text || '/runs/'
        || $4::uuid::text || '/artifacts/' || $1::uuid::text,
      $5, 8, 'text/plain', $6, ${deleteAfter}, $7, now())`,
    [
      artifactId,
      organizationId,
      projectId,
      runId,
      'a'.repeat(64),
      retentionClass,
      'service:00000000-0000-4000-8000-000000000805',
    ],
  )
}

async function seedRun(database: PGlite) {
  await database.query(
    `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Artifacts', 'artifacts')`,
    [organizationId],
  )
  await database.query(
    `INSERT INTO projects (id, organization_id, name, slug)
     VALUES ($1, $2, 'Artifacts', 'artifacts')`,
    [projectId, organizationId],
  )
  await database.query(
    `INSERT INTO repository_connections (
      id, organization_id, project_id, provider, installation_id, repository_id,
      owner, name, permissions, default_branch, indexed_commit, app_credential_ref,
      readiness, mutation_enabled, metadata, connected_at, verified_at
    ) VALUES ('00000000-0000-4000-8000-000000000810', $1, $2, 'github', 'installation',
      'repository', 'owner', 'repo', '{}', 'main', $3,
      '{"provider":"fixture","key":"credential/ref"}', 'ready', false, '{}', now(), now())`,
    [organizationId, projectId, 'a'.repeat(40)],
  )
  await database.query(
    `INSERT INTO change_requests (
      id, organization_id, project_id, actor_id, actor_type, idempotency_key,
      original_prompt, mode, target, constraints, attachments, status, created_at
    ) VALUES ('00000000-0000-4000-8000-000000000811', $1, $2,
      '00000000-0000-4000-8000-000000000812', 'user', 'artifact-change',
      'Artifact fixture', 'builder', 'preview', '[]', '[]', 'requirements_review', now())`,
    [organizationId, projectId],
  )
  await database.query(
    `INSERT INTO requirement_specs (
      id, organization_id, project_id, change_request_id, schema_version,
      revision, body, assumptions, created_at
    ) VALUES ('00000000-0000-4000-8000-000000000813', $1, $2,
      '00000000-0000-4000-8000-000000000811', '1', 1, '{}', '[]', now())`,
    [organizationId, projectId],
  )
  await database.query(
    `INSERT INTO execution_plans (
      id, organization_id, project_id, change_request_id, requirement_id, schema_version,
      revision, base_commit, risk_class, body, policy_snapshot, idempotency_key, created_at
    ) VALUES ('00000000-0000-4000-8000-000000000814', $1, $2,
      '00000000-0000-4000-8000-000000000811',
      '00000000-0000-4000-8000-000000000813', '1', 1, $3, 'low', '{}', '{}',
      'artifact-plan', now())`,
    [organizationId, projectId, 'a'.repeat(40)],
  )
  await database.query(
    `INSERT INTO runs (
      id, organization_id, project_id, change_request_id, execution_plan_id,
      base_commit, state, policy_snapshot, created_at
    ) VALUES ($1, $2, $3, '00000000-0000-4000-8000-000000000811',
      '00000000-0000-4000-8000-000000000814', $4, 'QUEUED', '{}', now())`,
    [runId, organizationId, projectId, 'a'.repeat(40)],
  )
}
