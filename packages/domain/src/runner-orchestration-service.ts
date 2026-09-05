import { createHash, randomUUID } from 'node:crypto'

import {
  runnerExecutionResultV1Schema,
  runnerLifecycleResultV1Schema,
  runnerWorkspaceV1Schema,
  type ActorContextV1,
  type PlanningResultV1,
  type RunnerCancellationRequestV1,
  type RunnerCleanupRequestV1,
  type RunnerExecutionCommandV1,
  type RunnerExecutionResultV1,
  type RunnerIsolationProfileV1,
  type RunnerLifecycleResultV1,
  type RunnerWorkspaceRequestV1,
  type RunnerWorkspaceV1,
  type RunV1,
} from '@platform/contracts'

import { authorize, type ServiceGrant } from './authorization.js'
import { PlatformError } from './error.js'
import { executionGateState } from './planning-policy.js'
import type { RunnerProviderPort } from './provider-ports.js'
import { evaluateRunnerCommand, runnerProfileDigest } from './runner-policy.js'
import { transitionRun } from './run-state.js'

export interface RunnerAuditEvent {
  readonly id: string
  readonly schemaVersion: '1'
  readonly organizationId: string
  readonly projectId: string
  readonly actorRef: string
  readonly action: string
  readonly targetRef: string
  readonly outcome: 'allowed' | 'denied' | 'succeeded' | 'failed'
  readonly correlationId: string
  readonly payloadRef?: string
  readonly occurredAt: Date
}

export interface RunnerPreparationContext {
  readonly planning: PlanningResultV1
  readonly currentPolicyVersion: string
  readonly repository: {
    readonly provider: string
    readonly repositoryId: string
    readonly indexedCommit: string
    readonly readiness: 'ready' | 'insufficient_permissions' | 'access_lost'
  }
}

export interface PersistedRunnerWorkspace {
  readonly requestDigest: string
  readonly profile: RunnerIsolationProfileV1
  readonly workspace: RunnerWorkspaceV1
}

export interface PersistedRunnerCommand {
  readonly requestDigest: string
  readonly result: RunnerExecutionResultV1
}

export interface PersistedRunnerLifecycle {
  readonly requestDigest: string
  readonly result: RunnerLifecycleResultV1
}

export interface RunnerWorkspaceContext extends PersistedRunnerWorkspace {
  readonly run: RunV1
}

export interface RunnerOrchestrationStore {
  findServiceGrant(organizationId: string, actorId: string): Promise<ServiceGrant | undefined>
  findPreparationContext(
    organizationId: string,
    projectId: string,
    runId: string,
    executionPlanId: string,
  ): Promise<RunnerPreparationContext | undefined>
  findWorkspaceByIdempotencyKey(
    organizationId: string,
    projectId: string,
    idempotencyKey: string,
  ): Promise<PersistedRunnerWorkspace | undefined>
  findWorkspaceContext(
    organizationId: string,
    projectId: string,
    workspaceId: string,
    runId: string,
  ): Promise<RunnerWorkspaceContext | undefined>
  savePreparedWorkspace(input: {
    readonly requestDigest: string
    readonly idempotencyKey: string
    readonly profile: RunnerIsolationProfileV1
    readonly workspace: RunnerWorkspaceV1
    readonly run: RunV1
    readonly auditEvents: readonly RunnerAuditEvent[]
  }): Promise<void>
  findCommandByIdempotencyKey(
    organizationId: string,
    projectId: string,
    idempotencyKey: string,
  ): Promise<PersistedRunnerCommand | undefined>
  saveExecution(input: {
    readonly requestDigest: string
    readonly idempotencyKey: string
    readonly command: RunnerExecutionCommandV1
    readonly result: RunnerExecutionResultV1
    readonly run: RunV1
    readonly auditEvents: readonly RunnerAuditEvent[]
  }): Promise<void>
  findLifecycleByIdempotencyKey(
    organizationId: string,
    projectId: string,
    idempotencyKey: string,
    action: 'cancel' | 'cleanup',
  ): Promise<PersistedRunnerLifecycle | undefined>
  saveLifecycle(input: {
    readonly id: string
    readonly action: 'cancel' | 'cleanup'
    readonly requestDigest: string
    readonly idempotencyKey: string
    readonly organizationId: string
    readonly projectId: string
    readonly workspaceId: string
    readonly runId: string
    readonly result: RunnerLifecycleResultV1
    readonly run?: RunV1
    readonly auditEvents: readonly RunnerAuditEvent[]
  }): Promise<void>
  appendAuditEvent(event: RunnerAuditEvent): Promise<void>
}

export class RunnerOrchestrationService {
  readonly #clock: () => Date
  readonly #idFactory: () => string
  readonly #runner: RunnerProviderPort
  readonly #store: RunnerOrchestrationStore

  constructor(options: {
    readonly clock?: () => Date
    readonly idFactory?: () => string
    readonly runner: RunnerProviderPort
    readonly store: RunnerOrchestrationStore
  }) {
    this.#clock = options.clock ?? (() => new Date())
    this.#idFactory = options.idFactory ?? randomUUID
    this.#runner = options.runner
    this.#store = options.store
  }

  async prepare(actor: ActorContextV1, request: RunnerWorkspaceRequestV1) {
    const now = this.#clock()
    this.#requireRequestActor(actor, request.context)
    await this.#requireExecutionPermission(
      actor,
      request.context.organizationId,
      request.context.projectId,
      now,
    )
    const requestDigest = digest(request)
    const existing = await this.#store.findWorkspaceByIdempotencyKey(
      request.context.organizationId,
      request.context.projectId,
      request.context.idempotencyKey,
    )
    if (existing !== undefined) {
      if (existing.requestDigest !== requestDigest) throw this.#conflict(actor)
      return existing.workspace
    }

    const context = await this.#store.findPreparationContext(
      request.context.organizationId,
      request.context.projectId,
      request.runId,
      request.executionPlanId,
    )
    if (context === undefined) throw this.#notFound(actor)
    const { planning, repository } = context
    if (
      planning.run.state !== 'QUEUED' ||
      executionGateState({ plan: planning.plan, approvals: planning.approvals }) !== 'QUEUED' ||
      context.currentPolicyVersion !== planning.plan.policySnapshot.policyVersion ||
      planning.run.baseCommit !== request.baseCommit ||
      planning.plan.baseCommit !== request.baseCommit ||
      repository.readiness !== 'ready' ||
      repository.provider !== request.repository.provider ||
      repository.repositoryId !== request.repository.repositoryId ||
      repository.indexedCommit !== request.baseCommit
    ) {
      await this.#store.appendAuditEvent(
        this.#audit(
          actor,
          request.context.organizationId,
          request.context.projectId,
          'runner.provision',
          'denied',
          now,
          `run:${request.runId}`,
          'reason:stale_or_unapproved',
        ),
      )
      throw this.#conflict(
        actor,
        'The run is no longer approved and current for workspace preparation.',
      )
    }

    const workspace = runnerWorkspaceV1Schema.parse(await this.#runner.provision(request))
    const profileDigest = runnerProfileDigest(request.profile)
    if (
      workspace.organizationId !== request.context.organizationId ||
      workspace.projectId !== request.context.projectId ||
      workspace.runId !== request.runId ||
      workspace.executionPlanId !== request.executionPlanId ||
      workspace.baseCommit !== request.baseCommit ||
      workspace.checkoutEvidence.commit !== request.baseCommit ||
      workspace.profileDigest !== profileDigest ||
      workspace.backendClass !== request.profile.backendClass ||
      workspace.state !== 'ready'
    ) {
      throw new PlatformError({
        code: 'VALIDATION_FAILED',
        correlationId: actor.correlationId,
        retryable: false,
        safeMessage: 'Runner workspace evidence did not match the approved request.',
      })
    }
    const run: RunV1 = {
      ...planning.run,
      state: transitionRun({
        authority: 'orchestrator',
        correlationId: actor.correlationId,
        from: 'QUEUED',
        to: 'PREPARING',
      }),
      startedAt: now.toISOString(),
    }
    await this.#store.savePreparedWorkspace({
      requestDigest,
      idempotencyKey: request.context.idempotencyKey,
      profile: request.profile,
      workspace,
      run,
      auditEvents: [
        this.#audit(
          actor,
          request.context.organizationId,
          request.context.projectId,
          'run.started',
          'succeeded',
          now,
          `run:${request.runId}`,
          `workspace:${workspace.id}`,
        ),
      ],
    })
    return workspace
  }

  async execute(actor: ActorContextV1, command: RunnerExecutionCommandV1) {
    const now = this.#clock()
    this.#requireRequestActor(actor, command.context)
    await this.#requireExecutionPermission(
      actor,
      command.context.organizationId,
      command.context.projectId,
      now,
    )
    const requestDigest = digest(command)
    const existing = await this.#store.findCommandByIdempotencyKey(
      command.context.organizationId,
      command.context.projectId,
      command.context.idempotencyKey,
    )
    if (existing !== undefined) {
      if (existing.requestDigest !== requestDigest) throw this.#conflict(actor)
      return existing.result
    }
    const context = await this.#store.findWorkspaceContext(
      command.context.organizationId,
      command.context.projectId,
      command.workspaceId,
      command.runId,
    )
    if (context === undefined) throw this.#notFound(actor)
    if (!['PREPARING', 'IMPLEMENTING', 'VALIDATING'].includes(context.run.state)) {
      throw this.#conflict(actor, 'The run is not executable in its current state.')
    }
    const decision = evaluateRunnerCommand({
      command,
      profile: context.profile,
      workspace: context.workspace,
    })
    if (!decision.allowed) {
      throw new PlatformError({
        code: 'AUTHORIZATION_DENIED',
        correlationId: actor.correlationId,
        retryable: false,
        safeMessage: `Runner command denied by policy: ${decision.rejectionCode}.`,
      })
    }
    const result = runnerExecutionResultV1Schema.parse(await this.#runner.execute(command))
    if (
      result.commandId !== command.id ||
      result.workspaceId !== command.workspaceId ||
      result.runId !== command.runId ||
      result.baseCommit !== command.baseCommit ||
      result.profileDigest !== command.profileDigest
    ) {
      throw new PlatformError({
        code: 'VALIDATION_FAILED',
        correlationId: actor.correlationId,
        retryable: false,
        safeMessage: 'Runner command evidence did not match the approved workspace.',
      })
    }
    const run = this.#runAfterExecution(context.run, result, actor, now)
    await this.#store.saveExecution({
      requestDigest,
      idempotencyKey: command.context.idempotencyKey,
      command,
      result,
      run,
      auditEvents: [
        this.#audit(
          actor,
          command.context.organizationId,
          command.context.projectId,
          'tool.completed',
          result.status === 'succeeded' ? 'succeeded' : 'failed',
          now,
          `command:${command.id}`,
          `status:${result.status}`,
        ),
      ],
    })
    return result
  }

  async cancel(actor: ActorContextV1, request: RunnerCancellationRequestV1) {
    return this.#lifecycle(actor, 'cancel', request)
  }

  async cleanup(actor: ActorContextV1, request: RunnerCleanupRequestV1) {
    return this.#lifecycle(actor, 'cleanup', request)
  }

  async #lifecycle(
    actor: ActorContextV1,
    action: 'cancel' | 'cleanup',
    request: RunnerCancellationRequestV1 | RunnerCleanupRequestV1,
  ) {
    const now = this.#clock()
    this.#requireRequestActor(actor, request.context)
    await this.#requireExecutionPermission(
      actor,
      request.context.organizationId,
      request.context.projectId,
      now,
    )
    const requestDigest = digest(request)
    const existing = await this.#store.findLifecycleByIdempotencyKey(
      request.context.organizationId,
      request.context.projectId,
      request.context.idempotencyKey,
      action,
    )
    if (existing !== undefined) {
      if (existing.requestDigest !== requestDigest) throw this.#conflict(actor)
      return existing.result
    }
    const context = await this.#store.findWorkspaceContext(
      request.context.organizationId,
      request.context.projectId,
      request.workspaceId,
      request.runId,
    )
    if (context === undefined) throw this.#notFound(actor)
    if (
      action === 'cancel' &&
      !['PREPARING', 'IMPLEMENTING', 'VALIDATING', 'CANCELLED'].includes(context.run.state)
    ) {
      throw this.#conflict(actor, 'The run is not cancellable in its current state.')
    }
    const result = runnerLifecycleResultV1Schema.parse(
      action === 'cancel'
        ? await this.#runner.cancel(request as RunnerCancellationRequestV1)
        : await this.#runner.destroy(request),
    )
    const run =
      action === 'cancel' && context.run.state !== 'CANCELLED'
        ? {
            ...context.run,
            state: transitionRun({
              authority: 'orchestrator',
              correlationId: actor.correlationId,
              from: context.run.state,
              to: 'CANCELLED',
            }),
            endedAt: now.toISOString(),
          }
        : undefined
    await this.#store.saveLifecycle({
      id: this.#idFactory(),
      action,
      requestDigest,
      idempotencyKey: request.context.idempotencyKey,
      organizationId: request.context.organizationId,
      projectId: request.context.projectId,
      workspaceId: request.workspaceId,
      runId: request.runId,
      result,
      ...(run === undefined ? {} : { run }),
      auditEvents: [
        this.#audit(
          actor,
          request.context.organizationId,
          request.context.projectId,
          `runner.${action}`,
          'succeeded',
          now,
          `workspace:${request.workspaceId}`,
          `status:${result.status}`,
        ),
      ],
    })
    return result
  }

  async #requireExecutionPermission(
    actor: ActorContextV1,
    organizationId: string,
    projectId: string,
    now: Date,
  ) {
    const serviceGrant =
      actor.actorType === 'service'
        ? await this.#store.findServiceGrant(organizationId, actor.actorId)
        : undefined
    const decision = authorize({
      actor,
      correlationId: actor.correlationId,
      decidedAt: now,
      ...(serviceGrant === undefined ? {} : { serviceGrant }),
      organizationId,
      projectId,
      permission: 'run:execute',
    })
    await this.#store.appendAuditEvent(
      this.#audit(
        actor,
        organizationId,
        projectId,
        'authorization.run:execute',
        decision.allowed ? 'allowed' : 'denied',
        now,
        `project:${projectId}`,
        `reason:${decision.reason}`,
      ),
    )
    if (!decision.allowed) {
      throw new PlatformError({
        code: 'AUTHORIZATION_DENIED',
        correlationId: actor.correlationId,
        retryable: false,
        safeMessage: 'Runner execution authorization was denied.',
      })
    }
  }

  #requireRequestActor(actor: ActorContextV1, context: RunnerWorkspaceRequestV1['context']) {
    if (
      context.organizationId !== actor.organizationId ||
      context.actorRef !== `${actor.actorType}:${actor.actorId}` ||
      context.correlationId !== actor.correlationId
    ) {
      throw new PlatformError({
        code: 'AUTHORIZATION_DENIED',
        correlationId: actor.correlationId,
        retryable: false,
        safeMessage: 'Runner request attribution did not match the current actor.',
      })
    }
  }

  #runAfterExecution(
    run: RunV1,
    result: RunnerExecutionResultV1,
    actor: ActorContextV1,
    now: Date,
  ): RunV1 {
    const to =
      result.status === 'succeeded'
        ? 'IMPLEMENTING'
        : result.status === 'cancelled'
          ? 'CANCELLED'
          : 'FAILED'
    if (run.state === to) return run
    return {
      ...run,
      state: transitionRun({
        authority: 'orchestrator',
        correlationId: actor.correlationId,
        from: run.state,
        to,
      }),
      ...(['FAILED', 'CANCELLED'].includes(to) ? { endedAt: now.toISOString() } : {}),
    }
  }

  #audit(
    actor: ActorContextV1,
    organizationId: string,
    projectId: string,
    action: string,
    outcome: RunnerAuditEvent['outcome'],
    occurredAt: Date,
    targetRef: string,
    payloadRef?: string,
  ): RunnerAuditEvent {
    return {
      id: this.#idFactory(),
      schemaVersion: '1',
      organizationId,
      projectId,
      actorRef: `${actor.actorType}:${actor.actorId}`,
      action,
      targetRef,
      outcome,
      correlationId: actor.correlationId,
      ...(payloadRef === undefined ? {} : { payloadRef }),
      occurredAt,
    }
  }

  #conflict(
    actor: ActorContextV1,
    safeMessage = 'The idempotency key belongs to a different runner request.',
  ) {
    return new PlatformError({
      code: 'CONFLICT',
      correlationId: actor.correlationId,
      retryable: false,
      safeMessage,
    })
  }

  #notFound(actor: ActorContextV1) {
    return new PlatformError({
      code: 'NOT_FOUND',
      correlationId: actor.correlationId,
      retryable: false,
      safeMessage: 'The tenant-scoped runner context was not found.',
    })
  }
}

function digest(value: unknown): string {
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
