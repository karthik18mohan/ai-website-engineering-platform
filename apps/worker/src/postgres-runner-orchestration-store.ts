import {
  approvalRecordV1Schema,
  executionPlanV1Schema,
  runnerExecutionResultV1Schema,
  runnerIsolationProfileV1Schema,
  runnerLifecycleResultV1Schema,
  runnerWorkspaceV1Schema,
  runV1Schema,
  type ProjectPermissionV1,
  type RunnerExecutionResultV1,
} from '@platform/contracts'
import {
  auditEvents,
  approvals,
  executionPlans,
  policyProfiles,
  projects,
  repositoryConnections,
  runnerArtifacts,
  runnerCommands,
  runnerLifecycleRecords,
  runnerWorkspaces,
  runs,
  serviceIdentities,
  serviceIdentityPermissions,
  type PlatformDatabase,
} from '@platform/database'
import type {
  RunnerAuditEvent,
  RunnerOrchestrationStore,
  RunnerPreparationContext,
  RunnerWorkspaceContext,
} from '@platform/domain'
import { and, eq } from 'drizzle-orm'

export class PostgresRunnerOrchestrationStore implements RunnerOrchestrationStore {
  constructor(private readonly database: PlatformDatabase) {}

  async findServiceGrant(organizationId: string, actorId: string) {
    const [identity] = await this.database
      .select()
      .from(serviceIdentities)
      .where(
        and(
          eq(serviceIdentities.organizationId, organizationId),
          eq(serviceIdentities.id, actorId),
        ),
      )
      .limit(1)
    if (identity === undefined) return undefined
    const permissionRows = await this.database
      .select({ permission: serviceIdentityPermissions.permission })
      .from(serviceIdentityPermissions)
      .where(
        and(
          eq(serviceIdentityPermissions.organizationId, organizationId),
          eq(serviceIdentityPermissions.serviceIdentityId, actorId),
        ),
      )
    return {
      actorId: identity.id,
      organizationId: identity.organizationId,
      ...(identity.projectId === null ? {} : { projectId: identity.projectId }),
      permissions: permissionRows.map(({ permission }) => permission) as ProjectPermissionV1[],
      status: identity.status as 'active' | 'suspended' | 'revoked',
    }
  }

  async findPreparationContext(
    organizationId: string,
    projectId: string,
    runId: string,
    executionPlanId: string,
  ): Promise<RunnerPreparationContext | undefined> {
    const [planRows, runRows, approvalRows, policyRows, repository] = await Promise.all([
      this.database
        .select({ body: executionPlans.body })
        .from(executionPlans)
        .where(
          and(
            eq(executionPlans.organizationId, organizationId),
            eq(executionPlans.projectId, projectId),
            eq(executionPlans.id, executionPlanId),
          ),
        )
        .limit(1),
      this.database
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.organizationId, organizationId),
            eq(runs.projectId, projectId),
            eq(runs.id, runId),
            eq(runs.executionPlanId, executionPlanId),
          ),
        )
        .limit(1),
      this.database
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.organizationId, organizationId),
            eq(approvals.projectId, projectId),
            eq(approvals.runId, runId),
            eq(approvals.planId, executionPlanId),
          ),
        ),
      this.database
        .select({ updatedAt: policyProfiles.updatedAt })
        .from(projects)
        .innerJoin(
          policyProfiles,
          and(
            eq(policyProfiles.organizationId, projects.organizationId),
            eq(policyProfiles.id, projects.policyId),
          ),
        )
        .where(and(eq(projects.organizationId, organizationId), eq(projects.id, projectId)))
        .limit(1),
      this.database
        .select({
          provider: repositoryConnections.provider,
          repositoryId: repositoryConnections.repositoryId,
          indexedCommit: repositoryConnections.indexedCommit,
          readiness: repositoryConnections.readiness,
        })
        .from(repositoryConnections)
        .where(
          and(
            eq(repositoryConnections.organizationId, organizationId),
            eq(repositoryConnections.projectId, projectId),
          ),
        )
        .limit(1),
    ])
    const planRow = planRows[0]
    const runRow = runRows[0]
    const policyRow = policyRows[0]
    const repositoryRow = repository[0]
    if (
      planRow === undefined ||
      runRow === undefined ||
      policyRow === undefined ||
      repositoryRow === undefined
    ) {
      return undefined
    }
    return {
      planning: {
        schemaVersion: '1' as const,
        plan: executionPlanV1Schema.parse(planRow.body),
        run: parseRun(runRow),
        approvals: approvalRows.map(parseApproval),
      },
      currentPolicyVersion: `policy:${policyRow.updatedAt.toISOString()}`,
      repository: {
        ...repositoryRow,
        readiness: repositoryRow.readiness as 'ready' | 'insufficient_permissions' | 'access_lost',
      },
    }
  }

  async findWorkspaceByIdempotencyKey(
    organizationId: string,
    projectId: string,
    idempotencyKey: string,
  ) {
    const [row] = await this.database
      .select()
      .from(runnerWorkspaces)
      .where(
        and(
          eq(runnerWorkspaces.organizationId, organizationId),
          eq(runnerWorkspaces.projectId, projectId),
          eq(runnerWorkspaces.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1)
    return row === undefined ? undefined : workspaceRecord(row)
  }

  async findWorkspaceContext(
    organizationId: string,
    projectId: string,
    workspaceId: string,
    runId: string,
  ): Promise<RunnerWorkspaceContext | undefined> {
    const [row] = await this.database
      .select({ workspace: runnerWorkspaces, run: runs })
      .from(runnerWorkspaces)
      .innerJoin(
        runs,
        and(
          eq(runs.organizationId, runnerWorkspaces.organizationId),
          eq(runs.projectId, runnerWorkspaces.projectId),
          eq(runs.id, runnerWorkspaces.runId),
        ),
      )
      .where(
        and(
          eq(runnerWorkspaces.organizationId, organizationId),
          eq(runnerWorkspaces.projectId, projectId),
          eq(runnerWorkspaces.id, workspaceId),
          eq(runnerWorkspaces.runId, runId),
        ),
      )
      .limit(1)
    if (row === undefined) return undefined
    return { ...workspaceRecord(row.workspace), run: parseRun(row.run) }
  }

  async savePreparedWorkspace(
    input: Parameters<RunnerOrchestrationStore['savePreparedWorkspace']>[0],
  ) {
    await this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(runs)
        .set({ state: input.run.state, startedAt: new Date(input.run.startedAt!) })
        .where(
          and(
            eq(runs.organizationId, input.run.organizationId),
            eq(runs.projectId, input.run.projectId),
            eq(runs.id, input.run.id),
            eq(runs.state, 'QUEUED'),
          ),
        )
        .returning({ id: runs.id })
      if (updated.length !== 1) throw new Error('Queued runner transition lost its tenant scope.')
      await transaction.insert(runnerWorkspaces).values({
        id: input.workspace.id,
        organizationId: input.workspace.organizationId,
        projectId: input.workspace.projectId,
        runId: input.workspace.runId,
        executionPlanId: input.workspace.executionPlanId,
        idempotencyKey: input.idempotencyKey,
        requestDigest: input.requestDigest,
        baseCommit: input.workspace.baseCommit,
        profileDigest: input.workspace.profileDigest,
        backendClass: input.workspace.backendClass,
        profile: input.profile,
        checkoutEvidence: input.workspace.checkoutEvidence,
        state: input.workspace.state,
        createdAt: new Date(input.workspace.createdAt),
        expiresAt: new Date(input.workspace.expiresAt),
      })
      await insertAudit(transaction, input.auditEvents)
    })
  }

  async findCommandByIdempotencyKey(
    organizationId: string,
    projectId: string,
    idempotencyKey: string,
  ) {
    const [row] = await this.database
      .select()
      .from(runnerCommands)
      .where(
        and(
          eq(runnerCommands.organizationId, organizationId),
          eq(runnerCommands.projectId, projectId),
          eq(runnerCommands.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1)
    if (row === undefined) return undefined
    const artifacts = await this.database
      .select()
      .from(runnerArtifacts)
      .where(
        and(
          eq(runnerArtifacts.organizationId, organizationId),
          eq(runnerArtifacts.projectId, projectId),
          eq(runnerArtifacts.commandId, row.id),
        ),
      )
    return { requestDigest: row.requestDigest, result: commandResult(row, artifacts) }
  }

  async saveExecution(input: Parameters<RunnerOrchestrationStore['saveExecution']>[0]) {
    await this.database.transaction(async (transaction) => {
      const updated = await transaction
        .update(runs)
        .set({
          state: input.run.state,
          endedAt: input.run.endedAt === undefined ? null : new Date(input.run.endedAt),
        })
        .where(
          and(
            eq(runs.organizationId, input.run.organizationId),
            eq(runs.projectId, input.run.projectId),
            eq(runs.id, input.run.id),
          ),
        )
        .returning({ id: runs.id })
      if (updated.length !== 1) throw new Error('Runner execution lost its tenant-scoped run.')
      await transaction.insert(runnerCommands).values({
        id: input.command.id,
        organizationId: input.command.context.organizationId,
        projectId: input.command.context.projectId,
        runId: input.command.runId,
        workspaceId: input.command.workspaceId,
        idempotencyKey: input.idempotencyKey,
        requestDigest: input.requestDigest,
        baseCommit: input.result.baseCommit,
        profileDigest: input.result.profileDigest,
        tool: input.command.tool,
        executable: input.command.executable,
        workingDirectory: input.command.workingDirectory,
        timeoutMs: input.command.timeoutMs,
        executionKind: input.result.executionKind,
        status: input.result.status,
        exitCode: input.result.exitCode ?? null,
        rejectionCode: input.result.rejectionCode ?? null,
        stdoutRef: input.result.stdoutRef ?? null,
        stderrRef: input.result.stderrRef ?? null,
        startedAt: new Date(input.result.startedAt),
        completedAt: new Date(input.result.completedAt),
      })
      if (input.result.artifacts.length > 0) {
        await transaction.insert(runnerArtifacts).values(
          input.result.artifacts.map((artifact) => ({
            organizationId: input.command.context.organizationId,
            projectId: input.command.context.projectId,
            runId: input.command.runId,
            workspaceId: input.command.workspaceId,
            commandId: input.command.id,
            path: artifact.path,
            reference: artifact.reference,
            digest: artifact.reference.digest,
            mediaType: artifact.reference.mediaType,
            retentionClass: artifact.reference.retentionClass,
            sizeBytes: artifact.sizeBytes,
          })),
        )
      }
      await insertAudit(transaction, input.auditEvents)
    })
  }

  async findLifecycleByIdempotencyKey(
    organizationId: string,
    projectId: string,
    idempotencyKey: string,
    action: 'cancel' | 'cleanup',
  ) {
    const [row] = await this.database
      .select()
      .from(runnerLifecycleRecords)
      .where(
        and(
          eq(runnerLifecycleRecords.organizationId, organizationId),
          eq(runnerLifecycleRecords.projectId, projectId),
          eq(runnerLifecycleRecords.idempotencyKey, idempotencyKey),
          eq(runnerLifecycleRecords.action, action),
        ),
      )
      .limit(1)
    return row === undefined
      ? undefined
      : {
          requestDigest: row.requestDigest,
          result: runnerLifecycleResultV1Schema.parse({
            schemaVersion: '1',
            workspaceId: row.workspaceId,
            runId: row.runId,
            status: row.resultStatus,
            occurredAt: row.occurredAt.toISOString(),
          }),
        }
  }

  async saveLifecycle(input: Parameters<RunnerOrchestrationStore['saveLifecycle']>[0]) {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(runnerLifecycleRecords).values({
        id: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        runId: input.runId,
        workspaceId: input.workspaceId,
        action: input.action,
        idempotencyKey: input.idempotencyKey,
        requestDigest: input.requestDigest,
        resultStatus: input.result.status,
        occurredAt: new Date(input.result.occurredAt),
      })
      const workspaceState = input.action === 'cleanup' ? 'destroyed' : 'cancelled'
      const workspaceUpdated = await transaction
        .update(runnerWorkspaces)
        .set({ state: workspaceState })
        .where(
          and(
            eq(runnerWorkspaces.organizationId, input.organizationId),
            eq(runnerWorkspaces.projectId, input.projectId),
            eq(runnerWorkspaces.id, input.workspaceId),
            eq(runnerWorkspaces.runId, input.runId),
          ),
        )
        .returning({ id: runnerWorkspaces.id })
      if (workspaceUpdated.length !== 1) {
        throw new Error('Runner lifecycle lost its tenant-scoped workspace.')
      }
      if (input.run !== undefined) {
        const runUpdated = await transaction
          .update(runs)
          .set({ state: input.run.state, endedAt: new Date(input.run.endedAt!) })
          .where(
            and(
              eq(runs.organizationId, input.run.organizationId),
              eq(runs.projectId, input.run.projectId),
              eq(runs.id, input.run.id),
            ),
          )
          .returning({ id: runs.id })
        if (runUpdated.length !== 1) throw new Error('Runner cancellation lost its scoped run.')
      }
      await insertAudit(transaction, input.auditEvents)
    })
  }

  appendAuditEvent(event: RunnerAuditEvent): Promise<void> {
    return this.database
      .insert(auditEvents)
      .values(auditValue(event))
      .then(() => undefined)
  }
}

function workspaceRecord(row: typeof runnerWorkspaces.$inferSelect) {
  return {
    requestDigest: row.requestDigest,
    profile: runnerIsolationProfileV1Schema.parse(row.profile),
    workspace: runnerWorkspaceV1Schema.parse({
      schemaVersion: '1',
      id: row.id,
      organizationId: row.organizationId,
      projectId: row.projectId,
      runId: row.runId,
      executionPlanId: row.executionPlanId,
      baseCommit: row.baseCommit,
      profileDigest: row.profileDigest,
      backendClass: row.backendClass,
      checkoutEvidence: row.checkoutEvidence,
      state: row.state,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }),
  }
}

function parseRun(row: typeof runs.$inferSelect) {
  return runV1Schema.parse({
    schemaVersion: '1',
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    changeRequestId: row.changeRequestId,
    executionPlanId: row.executionPlanId,
    baseCommit: row.baseCommit,
    state: row.state,
    policySnapshot: row.policySnapshot,
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt.toISOString() }),
    ...(row.endedAt === null ? {} : { endedAt: row.endedAt.toISOString() }),
  })
}

function parseApproval(row: typeof approvals.$inferSelect) {
  return approvalRecordV1Schema.parse({
    schemaVersion: '1',
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    runId: row.runId,
    planId: row.planId,
    planRevision: row.planRevision,
    gate: row.gate,
    decision: row.decision,
    requesterId: row.requesterId,
    policyVersion: row.policyVersion,
    requestedAt: row.requestedAt.toISOString(),
    ...(row.approverId === null ? {} : { approverId: row.approverId }),
    ...(row.rationale === null ? {} : { rationale: row.rationale }),
    ...(row.decidedAt === null ? {} : { decidedAt: row.decidedAt.toISOString() }),
  })
}

function commandResult(
  row: typeof runnerCommands.$inferSelect,
  artifacts: readonly (typeof runnerArtifacts.$inferSelect)[],
): RunnerExecutionResultV1 {
  return runnerExecutionResultV1Schema.parse({
    schemaVersion: '1',
    commandId: row.id,
    workspaceId: row.workspaceId,
    runId: row.runId,
    baseCommit: row.baseCommit,
    profileDigest: row.profileDigest,
    executionKind: row.executionKind,
    status: row.status,
    ...(row.exitCode === null ? {} : { exitCode: row.exitCode }),
    ...(row.rejectionCode === null ? {} : { rejectionCode: row.rejectionCode }),
    ...(row.stdoutRef === null ? {} : { stdoutRef: row.stdoutRef }),
    ...(row.stderrRef === null ? {} : { stderrRef: row.stderrRef }),
    artifacts: artifacts.map((artifact) => ({
      path: artifact.path,
      commandId: artifact.commandId,
      reference: artifact.reference,
      sizeBytes: artifact.sizeBytes,
    })),
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt.toISOString(),
  })
}

async function insertAudit(
  transaction: Parameters<Parameters<PlatformDatabase['transaction']>[0]>[0],
  events: readonly RunnerAuditEvent[],
) {
  if (events.length > 0) await transaction.insert(auditEvents).values(events.map(auditValue))
}

function auditValue(event: RunnerAuditEvent) {
  return {
    id: event.id,
    schemaVersion: event.schemaVersion,
    organizationId: event.organizationId,
    projectId: event.projectId,
    actorRef: event.actorRef,
    action: event.action,
    targetRef: event.targetRef,
    outcome: event.outcome,
    correlationId: event.correlationId,
    payloadRef: event.payloadRef ?? null,
    occurredAt: event.occurredAt,
  }
}
