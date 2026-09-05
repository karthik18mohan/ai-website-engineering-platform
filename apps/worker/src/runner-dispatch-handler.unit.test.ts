import { createHash } from 'node:crypto'

import {
  RUNNER_DISPATCH_ARTIFACT_MEDIA_TYPE,
  RUNNER_DISPATCH_ARTIFACT_RETENTION_CLASS,
  type ArtifactReferenceV1,
  type ProviderRequestContextV1,
  type RunnerDispatchEnvelopeV1,
} from '@platform/contracts'
import { PlatformError, type ArtifactReaderPort } from '@platform/domain'
import { describe, expect, it, vi } from 'vitest'

import type { DurableDispatchWork } from './postgres-durable-dispatch.js'
import { RunnerDispatchHandler, type RunnerDispatchService } from './runner-dispatch-handler.js'

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
const organizationId = id('1')
const projectId = id('2')
const actorId = id('3')
const correlationId = id('4')
const now = new Date('2026-08-16T12:00:00.000Z')

describe('RunnerDispatchHandler', () => {
  it('reads in tenant scope, verifies the artifact, and delegates authority to orchestration', async () => {
    const fixture = createFixture()
    await fixture.handler.handle(fixture.work)
    expect(fixture.read).toHaveBeenCalledWith(fixture.work.context, fixture.work.commandRef)
    expect(fixture.execute).toHaveBeenCalledWith(fixture.envelope.actor, fixture.envelope.request)
  })

  it('rejects artifact metadata, digest, and durable-context substitution before orchestration', async () => {
    const metadata = createFixture({ retentionClass: 'untrusted' })
    await expect(metadata.handler.handle(metadata.work)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: false,
    })
    expect(metadata.read).not.toHaveBeenCalled()

    const digest = createFixture({ referenceDigest: 'f'.repeat(64) })
    await expect(digest.handler.handle(digest.work)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: false,
    })
    expect(digest.execute).not.toHaveBeenCalled()

    const substitution = createFixture({ innerProjectId: id('99') })
    await expect(substitution.handler.handle(substitution.work)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: false,
    })
    expect(substitution.execute).not.toHaveBeenCalled()
  })

  it('rejects expired service evidence before the current grant is evaluated', async () => {
    const fixture = createFixture({ actorExpiresAt: '2026-08-16T12:00:00.000Z' })
    await expect(fixture.handler.handle(fixture.work)).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
      retryable: false,
    })
    expect(fixture.execute).not.toHaveBeenCalled()
  })

  it('preserves typed protected-store availability failures for bounded queue retry', async () => {
    const fixture = createFixture({
      readFailure: new PlatformError({
        code: 'DEPENDENCY_UNAVAILABLE',
        correlationId,
        retryable: true,
        safeMessage: 'Protected fixture store unavailable.',
      }),
    })
    await expect(fixture.handler.handle(fixture.work)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      retryable: true,
    })
    expect(fixture.execute).not.toHaveBeenCalled()
  })
})

function createFixture(
  options: {
    readonly actorExpiresAt?: string
    readonly innerProjectId?: string
    readonly readFailure?: Error
    readonly referenceDigest?: string
    readonly retentionClass?: string
  } = {},
) {
  const context: ProviderRequestContextV1 = {
    schemaVersion: '1',
    organizationId,
    projectId,
    actorRef: `service:${actorId}`,
    correlationId,
    idempotencyKey: 'runner-dispatch-handler',
    requestedAt: '2026-08-16T11:59:30.000Z',
  }
  const envelope: RunnerDispatchEnvelopeV1 = {
    schemaVersion: '1',
    actor: {
      schemaVersion: '1',
      actorId,
      actorType: 'service',
      authenticationMethod: 'oidc',
      correlationId,
      issuedAt: '2026-08-16T11:59:00.000Z',
      organizationId,
      sessionId: id('5'),
      subject: 'runner-worker',
      ...(options.actorExpiresAt === undefined ? {} : { expiresAt: options.actorExpiresAt }),
    },
    operation: 'execute',
    request: {
      schemaVersion: '1',
      context: { ...context, projectId: options.innerProjectId ?? projectId },
      id: id('6'),
      workspaceId: id('7'),
      runId: id('8'),
      baseCommit: 'a'.repeat(40),
      profileDigest: 'b'.repeat(64),
      tool: 'npm',
      executable: 'npm',
      arguments: ['test'],
      workingDirectory: 'workspace',
      timeoutMs: 60_000,
      expectedArtifacts: [],
    },
  }
  const content = new TextEncoder().encode(JSON.stringify(envelope))
  const reference: ArtifactReferenceV1 = {
    schemaVersion: '1',
    uri: `protected-artifact://${id('9')}`,
    digest: options.referenceDigest ?? createHash('sha256').update(content).digest('hex'),
    mediaType: RUNNER_DISPATCH_ARTIFACT_MEDIA_TYPE,
    retentionClass: options.retentionClass ?? RUNNER_DISPATCH_ARTIFACT_RETENTION_CLASS,
  }
  const read = vi.fn<ArtifactReaderPort['read']>(() => {
    if (options.readFailure !== undefined) return Promise.reject(options.readFailure)
    return Promise.resolve(content)
  })
  const execute = vi.fn(() => Promise.resolve())
  const service: RunnerDispatchService = {
    prepare: vi.fn(() => Promise.resolve()),
    execute,
    cancel: vi.fn(() => Promise.resolve()),
    cleanup: vi.fn(() => Promise.resolve()),
  }
  const work: DurableDispatchWork = {
    dispatchId: id('10'),
    attempt: 1,
    context,
    commandRef: reference,
  }
  return {
    envelope,
    execute,
    handler: new RunnerDispatchHandler({ read }, service, { clock: () => now }),
    read,
    service,
    work,
  }
}
