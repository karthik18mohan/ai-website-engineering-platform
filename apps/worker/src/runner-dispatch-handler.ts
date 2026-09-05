import { createHash } from 'node:crypto'

import {
  artifactReferenceV1Schema,
  providerRequestContextV1Schema,
  RUNNER_DISPATCH_ARTIFACT_MEDIA_TYPE,
  RUNNER_DISPATCH_ARTIFACT_RETENTION_CLASS,
  runnerDispatchEnvelopeV1Schema,
  type ActorContextV1,
  type RunnerCancellationRequestV1,
  type RunnerCleanupRequestV1,
  type RunnerExecutionCommandV1,
  type RunnerWorkspaceRequestV1,
} from '@platform/contracts'
import {
  PlatformError,
  type ArtifactReaderPort,
  type RunnerOrchestrationService,
} from '@platform/domain'

import type { DurableDispatchHandler, DurableDispatchWork } from './postgres-durable-dispatch.js'

export interface RunnerDispatchService {
  prepare(actor: ActorContextV1, request: RunnerWorkspaceRequestV1): Promise<unknown>
  execute(actor: ActorContextV1, request: RunnerExecutionCommandV1): Promise<unknown>
  cancel(actor: ActorContextV1, request: RunnerCancellationRequestV1): Promise<unknown>
  cleanup(actor: ActorContextV1, request: RunnerCleanupRequestV1): Promise<unknown>
}

export interface RunnerDispatchHandlerOptions {
  readonly clock?: () => Date
  readonly maxArtifactBytes?: number
}

/**
 * Resolves only a protected artifact reference, verifies its bytes and metadata,
 * validates the complete versioned command envelope, then delegates authority
 * to RunnerOrchestrationService. It never authorizes or mutates run state itself.
 */
export class RunnerDispatchHandler implements DurableDispatchHandler {
  readonly #artifacts: ArtifactReaderPort
  readonly #clock: () => Date
  readonly #maxArtifactBytes: number
  readonly #service: RunnerDispatchService

  constructor(
    artifacts: ArtifactReaderPort,
    service: RunnerDispatchService | RunnerOrchestrationService,
    options: RunnerDispatchHandlerOptions = {},
  ) {
    this.#artifacts = artifacts
    this.#service = service
    this.#clock = options.clock ?? (() => new Date())
    this.#maxArtifactBytes = options.maxArtifactBytes ?? 1_048_576
    if (
      !Number.isInteger(this.#maxArtifactBytes) ||
      this.#maxArtifactBytes < 1_024 ||
      this.#maxArtifactBytes > 16_777_216
    ) {
      throw new Error('Runner dispatch artifact limit must be between 1024 and 16777216 bytes.')
    }
  }

  async handle(rawWork: DurableDispatchWork): Promise<void> {
    const context = providerRequestContextV1Schema.parse(rawWork.context)
    const reference = artifactReferenceV1Schema.parse(rawWork.commandRef)
    this.#requireArtifactMetadata(context.correlationId, reference)

    let content: Uint8Array
    try {
      content = await this.#artifacts.read(context, reference)
    } catch (cause) {
      if (cause instanceof PlatformError) throw cause
      throw cause
    }
    if (!(content instanceof Uint8Array) || content.byteLength > this.#maxArtifactBytes) {
      throw this.#validation(context.correlationId, 'Runner command artifact size is invalid.')
    }
    const digest = createHash('sha256').update(content).digest('hex')
    if (digest !== reference.digest) {
      throw this.#validation(
        context.correlationId,
        'Runner command artifact integrity verification failed.',
      )
    }

    let decoded: unknown
    try {
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
    } catch (cause) {
      throw this.#error(
        context.correlationId,
        'VALIDATION_FAILED',
        false,
        'Runner command artifact is not valid UTF-8 JSON.',
        cause,
      )
    }
    const parsed = runnerDispatchEnvelopeV1Schema.safeParse(decoded)
    if (!parsed.success) {
      throw this.#validation(context.correlationId, 'Runner command envelope is invalid.')
    }
    const envelope = parsed.data
    this.#requireDispatchBinding(context, envelope.request.context)
    this.#requireCurrentActor(context.correlationId, envelope.actor)

    switch (envelope.operation) {
      case 'prepare':
        await this.#service.prepare(envelope.actor, envelope.request)
        return
      case 'execute':
        await this.#service.execute(envelope.actor, envelope.request)
        return
      case 'cancel':
        await this.#service.cancel(envelope.actor, envelope.request)
        return
      case 'cleanup':
        await this.#service.cleanup(envelope.actor, envelope.request)
    }
  }

  #requireArtifactMetadata(
    correlationId: string,
    reference: ReturnType<typeof artifactReferenceV1Schema.parse>,
  ) {
    if (
      reference.mediaType !== RUNNER_DISPATCH_ARTIFACT_MEDIA_TYPE ||
      reference.retentionClass !== RUNNER_DISPATCH_ARTIFACT_RETENTION_CLASS
    ) {
      throw this.#validation(
        correlationId,
        'Runner command artifact metadata is not authorized for dispatch.',
      )
    }
  }

  #requireDispatchBinding(
    outer: ReturnType<typeof providerRequestContextV1Schema.parse>,
    inner: ReturnType<typeof providerRequestContextV1Schema.parse>,
  ) {
    if (
      outer.organizationId !== inner.organizationId ||
      outer.projectId !== inner.projectId ||
      outer.actorRef !== inner.actorRef ||
      outer.correlationId !== inner.correlationId ||
      outer.idempotencyKey !== inner.idempotencyKey ||
      outer.requestedAt !== inner.requestedAt
    ) {
      throw this.#validation(
        outer.correlationId,
        'Runner command artifact does not match its durable dispatch context.',
      )
    }
  }

  #requireCurrentActor(correlationId: string, actor: ActorContextV1) {
    const now = this.#clock().getTime()
    const issuedAt = new Date(actor.issuedAt).getTime()
    const expiresAt =
      actor.expiresAt === undefined ? undefined : new Date(actor.expiresAt).getTime()
    if (issuedAt > now || (expiresAt !== undefined && expiresAt <= now)) {
      throw this.#error(
        correlationId,
        'AUTHORIZATION_DENIED',
        false,
        'Runner dispatch actor evidence is not current.',
      )
    }
  }

  #validation(correlationId: string, safeMessage: string) {
    return this.#error(correlationId, 'VALIDATION_FAILED', false, safeMessage)
  }

  #error(
    correlationId: string,
    code: 'AUTHORIZATION_DENIED' | 'VALIDATION_FAILED',
    retryable: boolean,
    safeMessage: string,
    cause?: unknown,
  ) {
    return new PlatformError({
      ...(cause === undefined ? {} : { cause }),
      code,
      correlationId,
      retryable,
      safeMessage,
    })
  }
}
