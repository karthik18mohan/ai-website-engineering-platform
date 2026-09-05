import { createHash } from 'node:crypto'

import {
  runnerExecutionResultV1Schema,
  runnerIsolationProfileV1Schema,
  runnerWorkspaceV1Schema,
} from '@platform/contracts'
import {
  runnerProviderCommandReplays,
  runnerProviderSessions,
  type PlatformDatabase,
} from '@platform/database'
import {
  vercelSandboxWorkspacePlanSchema,
  type VercelRunnerSession,
  type VercelRunnerSessionStore,
} from '@platform/vercel-sandbox-runner'
import { and, eq, or } from 'drizzle-orm'

/**
 * Worker-owned durable recovery store. SDK handles and active promises remain
 * process-local; only credential-free plans and bounded result evidence persist.
 */
export class PostgresVercelRunnerSessionStore implements VercelRunnerSessionStore {
  constructor(private readonly database: PlatformDatabase) {}

  async findByProvisionKey(organizationId: string, projectId: string, provisionKey: string) {
    const [row] = await this.database
      .select()
      .from(runnerProviderSessions)
      .where(
        and(
          eq(runnerProviderSessions.organizationId, organizationId),
          eq(runnerProviderSessions.projectId, projectId),
          eq(runnerProviderSessions.provisionKey, provisionKey),
        ),
      )
      .limit(1)
    return row === undefined ? undefined : this.#hydrate(row)
  }

  async findByWorkspaceId(organizationId: string, projectId: string, workspaceId: string) {
    const [row] = await this.database
      .select()
      .from(runnerProviderSessions)
      .where(
        and(
          eq(runnerProviderSessions.organizationId, organizationId),
          eq(runnerProviderSessions.projectId, projectId),
          eq(runnerProviderSessions.workspaceId, workspaceId),
        ),
      )
      .limit(1)
    return row === undefined ? undefined : this.#hydrate(row)
  }

  async save(rawSession: VercelRunnerSession): Promise<void> {
    const plan = vercelSandboxWorkspacePlanSchema.parse(rawSession.plan)
    const profile = runnerIsolationProfileV1Schema.parse(rawSession.profile)
    const workspace = runnerWorkspaceV1Schema.parse(rawSession.workspace)
    const session: VercelRunnerSession = { ...rawSession, plan, profile, workspace }
    const identityDigest = sessionIdentityDigest(session)

    await this.database.transaction(async (transaction) => {
      let [existing] = await transaction
        .select()
        .from(runnerProviderSessions)
        .where(
          or(
            eq(runnerProviderSessions.provisionKey, session.provisionKey),
            eq(runnerProviderSessions.workspaceId, workspace.id),
          ),
        )
        .limit(1)

      if (existing === undefined) {
        const inserted = await transaction
          .insert(runnerProviderSessions)
          .values({
            provisionKey: session.provisionKey,
            organizationId: workspace.organizationId,
            projectId: workspace.projectId,
            runId: workspace.runId,
            executionPlanId: workspace.executionPlanId,
            workspaceId: workspace.id,
            provider: plan.provider,
            requestFingerprint: session.requestFingerprint,
            identityDigest,
            plan,
            profile,
            workspace,
          })
          .onConflictDoNothing()
          .returning({ provisionKey: runnerProviderSessions.provisionKey })
        if (inserted.length === 0) {
          ;[existing] = await transaction
            .select()
            .from(runnerProviderSessions)
            .where(
              or(
                eq(runnerProviderSessions.provisionKey, session.provisionKey),
                eq(runnerProviderSessions.workspaceId, workspace.id),
              ),
            )
            .limit(1)
          if (existing === undefined) {
            throw new Error('Runner provider session conflict could not be resolved safely.')
          }
        }
      }
      if (existing !== undefined) {
        if (
          existing.provisionKey !== session.provisionKey ||
          existing.organizationId !== workspace.organizationId ||
          existing.projectId !== workspace.projectId ||
          existing.identityDigest !== identityDigest
        ) {
          throw new Error('Runner provider session identity is already registered differently.')
        }
        const updated = await transaction
          .update(runnerProviderSessions)
          .set({ workspace, updatedAt: new Date() })
          .where(
            and(
              eq(runnerProviderSessions.organizationId, workspace.organizationId),
              eq(runnerProviderSessions.projectId, workspace.projectId),
              eq(runnerProviderSessions.provisionKey, session.provisionKey),
            ),
          )
          .returning({ provisionKey: runnerProviderSessions.provisionKey })
        if (updated.length !== 1) throw new Error('Runner provider session update lost scope.')
      }

      for (const [commandId, replay] of session.commands) {
        const result = runnerExecutionResultV1Schema.parse(replay.result)
        let [existingReplay] = await transaction
          .select()
          .from(runnerProviderCommandReplays)
          .where(
            and(
              eq(runnerProviderCommandReplays.organizationId, workspace.organizationId),
              eq(runnerProviderCommandReplays.projectId, workspace.projectId),
              eq(runnerProviderCommandReplays.commandId, commandId),
            ),
          )
          .limit(1)
        if (existingReplay === undefined) {
          const inserted = await transaction
            .insert(runnerProviderCommandReplays)
            .values({
              organizationId: workspace.organizationId,
              projectId: workspace.projectId,
              provisionKey: session.provisionKey,
              commandId,
              requestFingerprint: replay.fingerprint,
              result,
              completedAt: new Date(result.completedAt),
            })
            .onConflictDoNothing()
            .returning({ commandId: runnerProviderCommandReplays.commandId })
          if (inserted.length === 1) continue
          ;[existingReplay] = await transaction
            .select()
            .from(runnerProviderCommandReplays)
            .where(
              and(
                eq(runnerProviderCommandReplays.organizationId, workspace.organizationId),
                eq(runnerProviderCommandReplays.projectId, workspace.projectId),
                eq(runnerProviderCommandReplays.commandId, commandId),
              ),
            )
            .limit(1)
        }
        if (
          existingReplay === undefined ||
          existingReplay.provisionKey !== session.provisionKey ||
          existingReplay.requestFingerprint !== replay.fingerprint ||
          digest(existingReplay.result) !== digest(result)
        ) {
          throw new Error('Runner provider command replay conflicts with durable evidence.')
        }
      }
    })
  }

  async #hydrate(row: typeof runnerProviderSessions.$inferSelect): Promise<VercelRunnerSession> {
    const plan = vercelSandboxWorkspacePlanSchema.parse(row.plan)
    const profile = runnerIsolationProfileV1Schema.parse(row.profile)
    const workspace = runnerWorkspaceV1Schema.parse(row.workspace)
    const identity = sessionIdentityDigest({
      provisionKey: row.provisionKey,
      requestFingerprint: row.requestFingerprint,
      plan,
      profile,
      workspace,
    })
    if (identity !== row.identityDigest) {
      throw new Error('Runner provider session recovery evidence failed its identity digest.')
    }
    const replayRows = await this.database
      .select()
      .from(runnerProviderCommandReplays)
      .where(
        and(
          eq(runnerProviderCommandReplays.organizationId, row.organizationId),
          eq(runnerProviderCommandReplays.projectId, row.projectId),
          eq(runnerProviderCommandReplays.provisionKey, row.provisionKey),
        ),
      )
    return {
      provisionKey: row.provisionKey,
      requestFingerprint: row.requestFingerprint,
      plan,
      profile,
      workspace,
      commands: new Map(
        replayRows.map((replay) => [
          replay.commandId,
          {
            fingerprint: replay.requestFingerprint,
            result: runnerExecutionResultV1Schema.parse(replay.result),
          },
        ]),
      ),
      activeCommands: new Map(),
    }
  }
}

function sessionIdentityDigest(
  session: Pick<
    VercelRunnerSession,
    'provisionKey' | 'requestFingerprint' | 'plan' | 'profile' | 'workspace'
  >,
) {
  const workspaceIdentity = Object.fromEntries(
    Object.entries(session.workspace).filter(([key]) => key !== 'state'),
  )
  return digest({
    provisionKey: session.provisionKey,
    requestFingerprint: session.requestFingerprint,
    plan: session.plan,
    profile: session.profile,
    workspace: workspaceIdentity,
  })
}

function digest(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    )
  }
  return value
}
