import { PGlite } from '@electric-sql/pglite'
import type {
  ArtifactReferenceV1,
  ProviderRequestContextV1,
  RunnerIsolationProfileV1,
  RunnerWorkspaceV1,
} from '@platform/contracts'
import {
  defaultMigrationsFolder,
  workerDispatchAttempts,
  workerDispatches,
  type PlatformDatabase,
} from '@platform/database'
import { PlatformError, type RunnerProviderPort } from '@platform/domain'
import {
  type VercelRunnerSession,
  type VercelSandboxWorkspacePlan,
} from '@platform/vercel-sandbox-runner'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PostgresDurableDispatch } from './postgres-durable-dispatch.js'
import { PostgresVercelRunnerSessionStore } from './postgres-vercel-runner-session-store.js'
import { createRunnerDispatchRuntime } from './runner-dispatch-composition.js'

const organizationId = id('800')
const projectId = id('801')
const changeRequestId = id('802')
const requirementId = id('803')
const planId = id('804')
const runId = id('805')
const workspaceId = id('806')
const commandId = id('807')
const actorId = id('808')
const correlationId = id('809')
const baseCommit = 'a'.repeat(40)
const profileDigest = 'b'.repeat(64)
const nowIso = '2026-08-16T13:00:00.000Z'

describe('M08 durable runner state', () => {
  let pglite: PGlite
  let database: PlatformDatabase

  beforeEach(async () => {
    pglite = new PGlite()
    const pgliteDatabase = drizzle(pglite)
    await migrate(pgliteDatabase, { migrationsFolder: defaultMigrationsFolder })
    database = pgliteDatabase as unknown as PlatformDatabase
    await seedRun(pglite)
  })

  afterEach(async () => pglite.close())

  it('rehydrates credential-free provider recovery state and completed replays', async () => {
    const store = new PostgresVercelRunnerSessionStore(database)
    const session = fixtureSession()
    await store.save(session)

    const recovered = await new PostgresVercelRunnerSessionStore(database).findByWorkspaceId(
      organizationId,
      projectId,
      workspaceId,
    )
    expect(recovered).toMatchObject({
      provisionKey: session.provisionKey,
      requestFingerprint: session.requestFingerprint,
      workspace: { id: workspaceId, state: 'ready' },
    })
    expect(recovered?.handle).toBeUndefined()
    expect(recovered?.activeCommands.size).toBe(0)
    expect(recovered?.commands.get(commandId)?.result.status).toBe('succeeded')
    expect(await store.findByWorkspaceId(id('899'), projectId, workspaceId)).toBeUndefined()

    recovered!.workspace = { ...recovered!.workspace, state: 'destroyed' }
    await store.save(recovered!)
    expect(
      (await store.findByProvisionKey(organizationId, projectId, session.provisionKey))?.workspace
        .state,
    ).toBe('destroyed')
    await expect(
      pglite.query(`UPDATE runner_provider_sessions SET plan = '{}' WHERE provision_key = $1`, [
        session.provisionKey,
      ]),
    ).rejects.toThrow(/identity is immutable/u)
    await expect(
      pglite.query(
        `UPDATE runner_provider_command_replays SET request_fingerprint = $1 WHERE command_id = $2`,
        ['c'.repeat(64), commandId],
      ),
    ).rejects.toThrow(/append-only/u)
  })

  it('claims queued work through a reconstructed dispatch adapter after worker restart', async () => {
    const enqueue = new PostgresDurableDispatch(database, { idFactory: () => id('810') })
    const context = fixtureContext('dispatch-queued-restart')
    const reference = fixtureReference('c')
    const { dispatchId } = await enqueue.dispatch(context, reference)

    const recovered = new PostgresDurableDispatch(database, { idFactory: () => id('811') })
    const handled: Array<{ dispatchId: string; attempt: number }> = []
    expect(
      await recovered.runOne('worker-after-restart', {
        handle(work) {
          handled.push({ dispatchId: work.dispatchId, attempt: work.attempt })
          expect(work.context).toEqual(context)
          expect(work.commandRef).toEqual(reference)
          return Promise.resolve()
        },
      }),
    ).toBe(true)

    expect(handled).toEqual([{ dispatchId, attempt: 1 }])
    const [row] = await database.select().from(workerDispatches)
    expect(row).toMatchObject({ status: 'succeeded', attemptCount: 1 })
    const [attempt] = await database.select().from(workerDispatchAttempts)
    expect(attempt).toMatchObject({
      dispatchId,
      attemptNumber: 1,
      outcome: 'succeeded',
      workerId: 'worker-after-restart',
    })
  })

  it('deduplicates dispatch, retries only observed typed failures, and records attempts', async () => {
    let now = new Date(nowIso)
    const ids = [id('810'), id('811'), id('812'), id('813'), id('814')]
    const dispatch = new PostgresDurableDispatch(database, {
      clock: () => now,
      idFactory: () => ids.shift()!,
      maxAttempts: 2,
      retryBaseMs: 100,
    })
    const context = fixtureContext('dispatch-stable-key')
    const reference = fixtureReference('d')
    const first = await dispatch.dispatch(context, reference)
    expect(await dispatch.dispatch(context, reference)).toEqual(first)
    await expect(dispatch.dispatch(context, fixtureReference('e'))).rejects.toMatchObject({
      code: 'CONFLICT',
    })

    let calls = 0
    expect(
      await dispatch.runOne('worker-a', {
        handle: () => {
          calls += 1
          throw new PlatformError({
            code: 'DEPENDENCY_UNAVAILABLE',
            correlationId,
            retryable: true,
            safeMessage: 'Fixture provider is temporarily unavailable.',
          })
        },
      }),
    ).toBe(true)
    let [row] = await database.select().from(workerDispatches)
    expect(row).toMatchObject({ status: 'retry_wait', attemptCount: 1 })

    const recovered = new PostgresDurableDispatch(database, {
      clock: () => now,
      idFactory: () => ids.shift()!,
      maxAttempts: 2,
      retryBaseMs: 100,
    })
    expect(
      await recovered.runOne('worker-before-retry-timer', {
        handle: () => {
          calls += 1
          return Promise.resolve()
        },
      }),
    ).toBe(false)
    expect(calls).toBe(1)

    now = new Date(now.getTime() + 100)
    expect(
      await recovered.runOne('worker-b', {
        handle: () => {
          calls += 1
          return Promise.resolve()
        },
      }),
    ).toBe(true)
    ;[row] = await database.select().from(workerDispatches)
    expect(row).toMatchObject({ status: 'succeeded', attemptCount: 2 })
    expect(calls).toBe(2)
    const attempts = await database.select().from(workerDispatchAttempts)
    expect(attempts.map(({ outcome }) => outcome)).toEqual(['retry_scheduled', 'succeeded'])
  })

  it('fails an expired uncertain lease without re-executing its handler', async () => {
    let now = new Date(nowIso)
    const dispatch = new PostgresDurableDispatch(database, {
      clock: () => now,
      idFactory: sequence(id('820'), id('821')),
      leaseMs: 1_000,
    })
    const { dispatchId } = await dispatch.dispatch(
      fixtureContext('dispatch-expired-key'),
      fixtureReference('f'),
    )
    await pglite.query(
      `UPDATE worker_dispatches SET status = 'running', attempt_count = 1,
       lease_owner = 'lost-worker', lease_expires_at = $1, updated_at = $2
       WHERE id = $3`,
      [new Date(now.getTime() + 1_000), now, dispatchId],
    )
    now = new Date(now.getTime() + 1_001)
    let invoked = false
    expect(
      await dispatch.runOne('recovery-worker', {
        handle: () => {
          invoked = true
          return Promise.resolve()
        },
      }),
    ).toBe(false)
    expect(invoked).toBe(false)
    const [row] = await database.select().from(workerDispatches)
    expect(row).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      lastFailureCode: 'WORKER_LEASE_EXPIRED',
    })
    const [attempt] = await database.select().from(workerDispatchAttempts)
    expect(attempt).toMatchObject({ outcome: 'lease_expired', workerId: 'lost-worker' })
  })

  it('wires the runtime pump and fails unapproved artifact metadata before provider access', async () => {
    const enqueue = new PostgresDurableDispatch(database, { idFactory: () => id('825') })
    const { dispatchId } = await enqueue.dispatch(
      fixtureContext('dispatch-runtime-composition'),
      fixtureReference('9'),
    )
    let artifactRead = false
    let providerInvoked = false
    const unavailable = () => {
      providerInvoked = true
      return Promise.reject(new Error('Provider must not be reached.'))
    }
    const runner: RunnerProviderPort = {
      provision: unavailable,
      execute: unavailable,
      cancel: unavailable,
      destroy: unavailable,
    }
    const runtime = createRunnerDispatchRuntime({
      artifacts: {
        read() {
          artifactRead = true
          return Promise.reject(new Error('Artifact store must not be reached.'))
        },
      },
      database,
      pollIntervalMs: 10,
      runner,
      workerId: 'worker-composed',
    })
    await runtime.start()
    await waitForDispatchStatus(database, dispatchId, 'failed')
    await runtime.stop()

    expect(artifactRead).toBe(false)
    expect(providerInvoked).toBe(false)
    const [row] = await database.select().from(workerDispatches)
    expect(row).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      lastFailureCode: 'VALIDATION_FAILED',
    })
  })
})

function fixtureSession(): VercelRunnerSession {
  const profile: RunnerIsolationProfileV1 = {
    schemaVersion: '1',
    id: id('830'),
    version: 'v1',
    backendClass: 'production_isolation',
    image: {
      reference: `registry.example/runner@sha256:${'1'.repeat(64)}`,
      digest: '1'.repeat(64),
    },
    resources: {
      cpuMillicores: 1_000,
      memoryMiB: 2_048,
      timeoutMs: 60_000,
      maxProcesses: 16,
      maxFiles: 10_000,
      maxBytes: 10_000_000,
    },
    filesystem: { denyHostFilesystem: true, writableRoots: ['workspace'] },
    processes: { shell: false, allowedCommands: [{ tool: 'npm', executable: 'npm' }] },
    network: { mode: 'denied' },
    dependencies: {
      approvedRegistries: [],
      installScripts: 'denied',
      allowedInstallScripts: [],
    },
    secrets: { allowProductionSecrets: false, allowedReferenceKeys: [] },
    artifacts: {
      maxCount: 10,
      maxBytes: 1_000_000,
      allowedMediaTypes: ['application/json'],
      retentionClasses: ['test-evidence'],
    },
  }
  const plan: VercelSandboxWorkspacePlan = {
    provider: 'vercel_sandbox',
    correlationId,
    sdkVersion: '3.0.0',
    profileDigest,
    create: {
      name: `awp-${'2'.repeat(32)}`,
      image: profile.image.reference,
      resources: { vcpus: 1 },
      timeout: 60_000,
      networkPolicy: 'deny-all',
      persistent: false,
      ports: [],
      tags: { profile: profileDigest.slice(0, 24), run: runId.replaceAll('-', '').slice(0, 24) },
    },
    expected: {
      image: profile.image.reference,
      vcpus: 1,
      memoryMiB: 2_048,
      persistent: false,
      networkPolicy: 'deny-all',
    },
  }
  const workspace: RunnerWorkspaceV1 = {
    schemaVersion: '1',
    id: workspaceId,
    organizationId,
    projectId,
    runId,
    executionPlanId: planId,
    baseCommit,
    profileDigest,
    backendClass: 'production_isolation',
    checkoutEvidence: {
      source: 'isolated_runtime',
      commit: baseCommit,
      treeDigest: '3'.repeat(64),
      detached: true,
      clean: true,
    },
    state: 'ready',
    createdAt: nowIso,
    expiresAt: '2026-08-16T14:00:00.000Z',
  }
  return {
    provisionKey: '2'.repeat(64),
    requestFingerprint: '4'.repeat(64),
    plan,
    profile,
    workspace,
    commands: new Map([
      [
        commandId,
        {
          fingerprint: '5'.repeat(64),
          result: {
            schemaVersion: '1',
            commandId,
            workspaceId,
            runId,
            baseCommit,
            profileDigest,
            executionKind: 'isolated_runtime',
            status: 'succeeded',
            exitCode: 0,
            artifacts: [],
            startedAt: nowIso,
            completedAt: '2026-08-16T13:01:00.000Z',
          },
        },
      ],
    ]),
    activeCommands: new Map(),
  }
}

function fixtureContext(idempotencyKey: string): ProviderRequestContextV1 {
  return {
    schemaVersion: '1',
    organizationId,
    projectId,
    actorRef: `service:${actorId}`,
    correlationId,
    idempotencyKey,
    requestedAt: nowIso,
  }
}

function fixtureReference(seed: string): ArtifactReferenceV1 {
  return {
    schemaVersion: '1',
    uri: `artifact://dispatch/${seed}`,
    digest: seed.repeat(64),
    mediaType: 'application/vnd.aiwp.worker-command+json',
    retentionClass: 'workflow-command',
  }
}

async function seedRun(database: PGlite) {
  await database.query(
    `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Worker organization', 'worker-org')`,
    [organizationId],
  )
  await database.query(
    `INSERT INTO projects (id, organization_id, name, slug)
     VALUES ($1, $2, 'Worker project', 'worker-project')`,
    [projectId, organizationId],
  )
  await database.query(
    `INSERT INTO change_requests (
      id, organization_id, project_id, actor_id, actor_type, idempotency_key,
      original_prompt, mode, target, constraints, attachments, status, created_at
    ) VALUES ($1, $2, $3, $4, 'user', 'durable-change', 'Edit fixture', 'builder',
      'preview', '[]', '[]', 'requirements_review', now())`,
    [changeRequestId, organizationId, projectId, actorId],
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
    ) VALUES ($1, $2, $3, $4, $5, '1', 1, $6, 'low', '{}', '{}', 'durable-plan', now())`,
    [planId, organizationId, projectId, changeRequestId, requirementId, baseCommit],
  )
  await database.query(
    `INSERT INTO runs (
      id, organization_id, project_id, change_request_id, execution_plan_id,
      base_commit, state, policy_snapshot, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED', '{}', now())`,
    [runId, organizationId, projectId, changeRequestId, planId, baseCommit],
  )
}

function sequence(...values: string[]) {
  return () => values.shift()!
}

async function waitForDispatchStatus(
  database: PlatformDatabase,
  dispatchId: string,
  status: 'failed',
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await database
      .select({ status: workerDispatches.status })
      .from(workerDispatches)
      .where(eq(workerDispatches.id, dispatchId))
      .limit(1)
    if (row?.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Dispatch ${dispatchId} did not reach ${status}.`)
}

function id(seed: string) {
  return `00000000-0000-4000-8000-${seed.padStart(12, '0')}`
}
