import { createHash, randomUUID } from 'node:crypto'

import {
  artifactReferenceV1Schema,
  providerRequestContextV1Schema,
  type ArtifactReferenceV1,
  type ProviderRequestContextV1,
} from '@platform/contracts'
import { workerDispatchAttempts, workerDispatches, type PlatformDatabase } from '@platform/database'
import { PlatformError, type OrchestrationProviderPort } from '@platform/domain'
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'

export interface DurableDispatchWork {
  readonly dispatchId: string
  readonly attempt: number
  readonly context: ProviderRequestContextV1
  readonly commandRef: ArtifactReferenceV1
}

export interface DurableDispatchHandler {
  handle(work: DurableDispatchWork): Promise<void>
}

export interface PostgresDurableDispatchOptions {
  readonly clock?: () => Date
  readonly idFactory?: () => string
  readonly leaseMs?: number
  readonly maxAttempts?: number
  readonly retryBaseMs?: number
}

/**
 * Durable artifact-reference queue. It never persists command bodies, argv,
 * source, raw logs, or credentials. A lost lease is terminal because the
 * previous side effect is uncertain; only observed typed retryable failures
 * receive bounded automatic retry.
 */
export class PostgresDurableDispatch implements OrchestrationProviderPort {
  readonly #clock: () => Date
  readonly #database: PlatformDatabase
  readonly #idFactory: () => string
  readonly #leaseMs: number
  readonly #maxAttempts: number
  readonly #retryBaseMs: number

  constructor(database: PlatformDatabase, options: PostgresDurableDispatchOptions = {}) {
    this.#database = database
    this.#clock = options.clock ?? (() => new Date())
    this.#idFactory = options.idFactory ?? randomUUID
    this.#leaseMs = boundedInteger(options.leaseMs ?? 60_000, 1_000, 3_600_000, 'leaseMs')
    this.#maxAttempts = boundedInteger(options.maxAttempts ?? 3, 1, 10, 'maxAttempts')
    this.#retryBaseMs = boundedInteger(options.retryBaseMs ?? 1_000, 100, 3_600_000, 'retryBaseMs')
  }

  async dispatch(rawContext: ProviderRequestContextV1, rawCommandRef: ArtifactReferenceV1) {
    const context = providerRequestContextV1Schema.parse(rawContext)
    const commandRef = artifactReferenceV1Schema.parse(rawCommandRef)
    const requestDigest = digest({ context, commandRef })
    const dispatchId = this.#idFactory()
    const now = this.#clock()
    return this.#database.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(workerDispatches)
        .values({
          id: dispatchId,
          organizationId: context.organizationId,
          projectId: context.projectId,
          actorRef: context.actorRef,
          correlationId: context.correlationId,
          requestedAt: new Date(context.requestedAt),
          idempotencyKey: context.idempotencyKey,
          requestDigest,
          commandRef,
          status: 'queued',
          attemptCount: 0,
          maxAttempts: this.#maxAttempts,
          availableAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: workerDispatches.id })
      if (inserted.length === 1) return { dispatchId }
      const [existing] = await transaction
        .select()
        .from(workerDispatches)
        .where(
          and(
            eq(workerDispatches.organizationId, context.organizationId),
            eq(workerDispatches.projectId, context.projectId),
            eq(workerDispatches.idempotencyKey, context.idempotencyKey),
          ),
        )
        .limit(1)
      if (existing === undefined) throw new Error('Dispatch conflict could not be resolved safely.')
      if (existing.requestDigest !== requestDigest) {
        throw new PlatformError({
          code: 'CONFLICT',
          correlationId: context.correlationId,
          retryable: false,
          safeMessage: 'The dispatch idempotency key belongs to a different command reference.',
        })
      }
      return { dispatchId: existing.id }
    })
  }

  async runOne(workerId: string, handler: DurableDispatchHandler): Promise<boolean> {
    if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(workerId)) throw new Error('Worker ID is invalid.')
    const now = this.#clock()
    await this.#failExpiredLeases(now)
    const claim = await this.#claim(workerId, now)
    if (claim === undefined) return false
    const context = providerRequestContextV1Schema.parse({
      schemaVersion: '1',
      organizationId: claim.organizationId,
      projectId: claim.projectId,
      actorRef: claim.actorRef,
      correlationId: claim.correlationId,
      idempotencyKey: claim.idempotencyKey,
      requestedAt: claim.requestedAt.toISOString(),
    })
    try {
      await handler.handle({
        dispatchId: claim.id,
        attempt: claim.attemptCount,
        context,
        commandRef: artifactReferenceV1Schema.parse(claim.commandRef),
      })
      await this.#finish(claim, workerId, 'succeeded')
    } catch (cause) {
      const retryable = cause instanceof PlatformError && cause.retryable
      const failureCode = cause instanceof PlatformError ? cause.code : 'UNEXPECTED_FAILURE'
      await this.#finish(claim, workerId, retryable ? 'retryable_failure' : 'failed', failureCode)
    }
    return true
  }

  async #claim(workerId: string, now: Date) {
    return this.#database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select()
        .from(workerDispatches)
        .where(
          and(
            inArray(workerDispatches.status, ['queued', 'retry_wait']),
            lte(workerDispatches.availableAt, now),
          ),
        )
        .orderBy(asc(workerDispatches.availableAt), asc(workerDispatches.createdAt))
        .limit(1)
      if (candidate === undefined) return undefined
      const [claimed] = await transaction
        .update(workerDispatches)
        .set({
          status: 'running',
          attemptCount: sql`${workerDispatches.attemptCount} + 1`,
          leaseOwner: workerId,
          leaseExpiresAt: new Date(now.getTime() + this.#leaseMs),
          lastFailureCode: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(workerDispatches.id, candidate.id),
            eq(workerDispatches.organizationId, candidate.organizationId),
            eq(workerDispatches.projectId, candidate.projectId),
            eq(workerDispatches.status, candidate.status),
            eq(workerDispatches.attemptCount, candidate.attemptCount),
            lte(workerDispatches.availableAt, now),
          ),
        )
        .returning()
      return claimed
    })
  }

  async #finish(
    claim: typeof workerDispatches.$inferSelect,
    workerId: string,
    outcome: 'succeeded' | 'retryable_failure' | 'failed',
    failureCode?: string,
  ) {
    const completedAt = this.#clock()
    const canRetry = outcome === 'retryable_failure' && claim.attemptCount < claim.maxAttempts
    const nextAvailableAt = canRetry
      ? new Date(
          completedAt.getTime() +
            Math.min(this.#retryBaseMs * 2 ** (claim.attemptCount - 1), 3_600_000),
        )
      : undefined
    await this.#database.transaction(async (transaction) => {
      const updated = await transaction
        .update(workerDispatches)
        .set({
          status: outcome === 'succeeded' ? 'succeeded' : canRetry ? 'retry_wait' : 'failed',
          availableAt: nextAvailableAt ?? claim.availableAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastFailureCode: failureCode ?? null,
          updatedAt: completedAt,
          completedAt: outcome === 'succeeded' || !canRetry ? completedAt : null,
        })
        .where(
          and(
            eq(workerDispatches.id, claim.id),
            eq(workerDispatches.organizationId, claim.organizationId),
            eq(workerDispatches.projectId, claim.projectId),
            eq(workerDispatches.status, 'running'),
            eq(workerDispatches.attemptCount, claim.attemptCount),
            eq(workerDispatches.leaseOwner, workerId),
          ),
        )
        .returning({ id: workerDispatches.id })
      if (updated.length !== 1) throw new Error('Worker dispatch completion lost its lease.')
      await transaction.insert(workerDispatchAttempts).values({
        id: this.#idFactory(),
        organizationId: claim.organizationId,
        projectId: claim.projectId,
        dispatchId: claim.id,
        attemptNumber: claim.attemptCount,
        workerId,
        outcome: outcome === 'succeeded' ? 'succeeded' : canRetry ? 'retry_scheduled' : 'failed',
        failureCode: failureCode ?? null,
        startedAt: claim.updatedAt,
        completedAt,
        nextAvailableAt: nextAvailableAt ?? null,
      })
    })
  }

  async #failExpiredLeases(now: Date) {
    const expired = await this.#database
      .select()
      .from(workerDispatches)
      .where(and(eq(workerDispatches.status, 'running'), lte(workerDispatches.leaseExpiresAt, now)))
    for (const dispatch of expired) {
      await this.#database.transaction(async (transaction) => {
        const updated = await transaction
          .update(workerDispatches)
          .set({
            status: 'failed',
            leaseOwner: null,
            leaseExpiresAt: null,
            lastFailureCode: 'WORKER_LEASE_EXPIRED',
            updatedAt: now,
            completedAt: now,
          })
          .where(
            and(
              eq(workerDispatches.id, dispatch.id),
              eq(workerDispatches.organizationId, dispatch.organizationId),
              eq(workerDispatches.projectId, dispatch.projectId),
              eq(workerDispatches.status, 'running'),
              eq(workerDispatches.attemptCount, dispatch.attemptCount),
              eq(workerDispatches.leaseOwner, dispatch.leaseOwner!),
              lte(workerDispatches.leaseExpiresAt, now),
            ),
          )
          .returning({ id: workerDispatches.id })
        if (updated.length === 0) return
        await transaction.insert(workerDispatchAttempts).values({
          id: this.#idFactory(),
          organizationId: dispatch.organizationId,
          projectId: dispatch.projectId,
          dispatchId: dispatch.id,
          attemptNumber: dispatch.attemptCount,
          workerId: dispatch.leaseOwner!,
          outcome: 'lease_expired',
          failureCode: 'WORKER_LEASE_EXPIRED',
          startedAt: dispatch.updatedAt,
          completedAt: now,
        })
      })
    }
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
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
