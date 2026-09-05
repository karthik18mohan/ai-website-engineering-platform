import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultMigrationsFolder } from './migrate.js'

const organizationId = '00000000-0000-4000-8000-000000000800'
const projectId = '00000000-0000-4000-8000-000000000801'
const changeRequestId = '00000000-0000-4000-8000-000000000802'
const requirementId = '00000000-0000-4000-8000-000000000803'
const planId = '00000000-0000-4000-8000-000000000804'
const runId = '00000000-0000-4000-8000-000000000805'
const workspaceId = '00000000-0000-4000-8000-000000000806'
const commandId = '00000000-0000-4000-8000-000000000807'

describe('M08 runner lifecycle migration', () => {
  let database: PGlite

  beforeEach(async () => {
    database = new PGlite()
    await migrate(drizzle(database), { migrationsFolder: defaultMigrationsFolder })
    await database.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'M08 organization', 'm08-organization')`,
      [organizationId],
    )
    await database.query(
      `INSERT INTO projects (id, organization_id, name, slug)
       VALUES ($1, $2, 'M08 project', 'm08-project')`,
      [projectId, organizationId],
    )
    await database.query(
      `INSERT INTO repository_connections (
        id, organization_id, project_id, provider, installation_id, repository_id,
        owner, name, permissions, default_branch, indexed_commit, app_credential_ref,
        readiness, mutation_enabled, metadata, connected_at, verified_at
      ) VALUES ('00000000-0000-4000-8000-000000000899', $1, $2, 'github', 'installation',
        'repository', 'owner', 'repo', '{}', 'main', $3,
        '{"provider":"fixture","key":"credential/ref"}', 'ready', false, '{}', now(), now())`,
      [organizationId, projectId, 'a'.repeat(40)],
    )
    await database.query(
      `INSERT INTO change_requests (
        id, organization_id, project_id, actor_id, actor_type, idempotency_key,
        original_prompt, mode, target, constraints, attachments, status, created_at
      ) VALUES ($1, $2, $3, '00000000-0000-4000-8000-000000000898', 'user',
        'm08-change', 'Edit fixture', 'builder', 'preview', '[]', '[]',
        'requirements_review', now())`,
      [changeRequestId, organizationId, projectId],
    )
    await database.query(
      `INSERT INTO requirement_specs (
        id, organization_id, project_id, change_request_id, schema_version,
        revision, body, assumptions, created_at
      ) VALUES ($1, $2, $3, $4, '1', 1, '{}', '[]', now())`,
      [requirementId, organizationId, projectId, changeRequestId],
    )
    await database.query(
      `INSERT INTO execution_plans (
        id, organization_id, project_id, change_request_id, requirement_id, schema_version,
        revision, base_commit, risk_class, body, policy_snapshot, idempotency_key, created_at
      ) VALUES ($1, $2, $3, $4, $5, '1', 1, $6, 'low', '{}', '{}', 'm08-plan', now())`,
      [planId, organizationId, projectId, changeRequestId, requirementId, 'a'.repeat(40)],
    )
    await database.query(
      `INSERT INTO runs (
        id, organization_id, project_id, change_request_id, execution_plan_id,
        base_commit, state, policy_snapshot, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED', '{}', now())`,
      [runId, organizationId, projectId, changeRequestId, planId, 'a'.repeat(40)],
    )
  })

  afterEach(async () => database.close())

  it('creates scoped lifecycle tables without raw command or output columns', async () => {
    const tables = await database.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'runner_%'
      ORDER BY table_name
    `)
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      'runner_artifacts',
      'runner_commands',
      'runner_lifecycle_records',
      'runner_provider_command_replays',
      'runner_provider_sessions',
      'runner_workspaces',
    ])
    const columns = await database.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'runner_commands'
    `)
    expect(columns.rows.map(({ column_name }) => column_name)).not.toEqual(
      expect.arrayContaining(['arguments', 'stdout', 'stderr', 'environment', 'secrets']),
    )
  })

  it('enforces tenant bindings, idempotency, and append-only evidence', async () => {
    await insertWorkspace(database)
    await expect(insertWorkspace(database)).rejects.toThrow()
    await expect(
      database.query(
        `INSERT INTO runner_workspaces (
          id, organization_id, project_id, run_id, execution_plan_id, idempotency_key,
          request_digest, base_commit, profile_digest, backend_class, profile,
          checkout_evidence, state, created_at, expires_at
        ) VALUES ('00000000-0000-4000-8000-000000000897',
          '00000000-0000-4000-8000-000000000896', $1, $2, $3, 'cross-tenant',
          $4, $5, $4, 'conformance_fixture', '{}', '{}', 'ready', now(), now() + interval '1 hour')`,
        [projectId, runId, planId, 'b'.repeat(64), 'a'.repeat(40)],
      ),
    ).rejects.toThrow()
    await insertCommand(database)
    await expect(
      database.query(`UPDATE runner_commands SET status = 'failed' WHERE id = $1`, [commandId]),
    ).rejects.toThrow(/append-only/u)
  })

  it('permits only forward workspace cleanup states and the runner service permission', async () => {
    await insertWorkspace(database)
    await database.query(`UPDATE runner_workspaces SET state = 'cancelled' WHERE id = $1`, [
      workspaceId,
    ])
    await database.query(`UPDATE runner_workspaces SET state = 'destroyed' WHERE id = $1`, [
      workspaceId,
    ])
    await expect(
      database.query(`UPDATE runner_workspaces SET state = 'ready' WHERE id = $1`, [workspaceId]),
    ).rejects.toThrow(/invalid runner workspace transition/u)
    await database.query(
      `INSERT INTO service_identities (id, organization_id, project_id, name)
       VALUES ('00000000-0000-4000-8000-000000000895', $1, $2, 'runner')`,
      [organizationId, projectId],
    )
    await expect(
      database.query(
        `INSERT INTO service_identity_permissions
         (organization_id, service_identity_id, permission)
         VALUES ($1, '00000000-0000-4000-8000-000000000895', 'run:execute')`,
        [organizationId],
      ),
    ).resolves.toBeDefined()
  })
})

async function insertWorkspace(database: PGlite) {
  return database.query(
    `INSERT INTO runner_workspaces (
      id, organization_id, project_id, run_id, execution_plan_id, idempotency_key,
      request_digest, base_commit, profile_digest, backend_class, profile,
      checkout_evidence, state, created_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, 'workspace-idempotency', $6, $7, $6,
      'conformance_fixture', '{}', '{}', 'ready', now(), now() + interval '1 hour')`,
    [workspaceId, organizationId, projectId, runId, planId, 'b'.repeat(64), 'a'.repeat(40)],
  )
}

async function insertCommand(database: PGlite) {
  return database.query(
    `INSERT INTO runner_commands (
      id, organization_id, project_id, run_id, workspace_id, idempotency_key,
      request_digest, base_commit, profile_digest, tool, executable, working_directory,
      timeout_ms, execution_kind, status, exit_code, started_at, completed_at
    ) VALUES ($1, $2, $3, $4, $5, 'command-idempotency', $6, $7, $6,
      'npm', 'npm', '.', 1000, 'simulated_conformance', 'succeeded', 0, now(), now())`,
    [commandId, organizationId, projectId, runId, workspaceId, 'c'.repeat(64), 'a'.repeat(40)],
  )
}
