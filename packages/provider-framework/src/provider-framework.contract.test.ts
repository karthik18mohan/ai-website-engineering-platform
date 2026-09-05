import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ProviderCallbackProcessor } from '@platform/domain'
import {
  secretReferenceV1Schema,
  type ProviderCallbackEnvelopeV1,
  type ProviderRequestContextV1,
} from '@platform/contracts'
import { DigestCallbackVerifier, MemoryProviderCallbackStore } from './callback-mocks.js'
import { AiControlledRequirementRole } from './requirement-role.js'
import {
  DenyAllAiCostController,
  MockAttachmentScanner,
  MockArtifactStore,
  MockDeploymentAdapter,
  MockGitAdapter,
  MockOrchestrationAdapter,
  MockSecretsAdapter,
} from './mocks.js'

const context: ProviderRequestContextV1 = {
  schemaVersion: '1',
  organizationId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  actorRef: 'service:00000000-0000-4000-8000-000000000003',
  correlationId: '00000000-0000-4000-8000-000000000004',
  idempotencyKey: 'provider-fixture-1',
  requestedAt: '2026-08-11T00:00:00.000Z',
}

describe('M03 provider adapter conformance', () => {
  it('keeps secret material outside the reference contract', async () => {
    const adapter = new MockSecretsAdapter()
    const reference = {
      schemaVersion: '1' as const,
      provider: 'mock-vault',
      key: 'projects/example/github',
    }
    adapter.register(reference)
    expect(await adapter.exists(context, reference)).toBe(true)
    expect(JSON.stringify(reference)).not.toContain('token')
    expect(() =>
      secretReferenceV1Schema.parse({ ...reference, value: 'plaintext-secret' }),
    ).toThrow()
  })

  it('provides deterministic provider-neutral mock behavior', async () => {
    const git = await new MockGitAdapter().verifyRepository(context, {
      provider: 'mock',
      repositoryId: 'repo-1',
      defaultBranch: 'main',
    })
    const deploy = await new MockDeploymentAdapter().requestPreview({
      context,
      commit: 'a'.repeat(40),
      environment: 'preview',
    })
    const artifact = await new MockArtifactStore().put(
      context,
      new TextEncoder().encode('fixture'),
      { mediaType: 'text/plain', retentionClass: 'test' },
    )
    const dispatch = await new MockOrchestrationAdapter().dispatch(context, artifact)
    expect(git).toEqual({ accessible: true, defaultBranch: 'main' })
    expect(deploy).toMatchObject({ status: 'ready', providerDeploymentId: 'mock-aaaaaaaaaaaa' })
    expect(artifact.digest).toBe(createHash('sha256').update('fixture').digest('hex'))
    expect(dispatch.dispatchId).toContain(context.idempotencyKey)
  })

  it('denies every model request at the only application-facing AI port', async () => {
    const artifact = {
      schemaVersion: '1' as const,
      uri: 'mock-artifact://input',
      digest: '0'.repeat(64),
      mediaType: 'text/plain',
      retentionClass: 'test',
    }
    await expect(
      new DenyAllAiCostController().invoke({
        schemaVersion: '1',
        context,
        requestType: 'classification',
        inputRef: artifact,
        capability: 'text',
        dataClassification: 'internal',
        maximumCost: { currency: 'USD', amount: '0.01' },
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED', retryable: false })
  })

  it('maps provider outages to a typed safe retryable error', async () => {
    await expect(
      new MockDeploymentAdapter(false).requestPreview({
        context,
        commit: 'a'.repeat(40),
        environment: 'preview',
      }),
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      retryable: true,
      safeMessage: 'The deployment provider is unavailable.',
    })
  })
})

describe('M03 callback safety', () => {
  const payload = new TextEncoder().encode('{"event":"push"}')
  const envelope = (
    id: string,
    sequence: number,
    signature = 'fixture-signature',
  ): ProviderCallbackEnvelopeV1 => ({
    schemaVersion: '1',
    provider: 'mock-git',
    externalEventId: id,
    eventType: 'push',
    actorRef: 'service:00000000-0000-4000-8000-000000000099',
    organizationId: context.organizationId,
    projectId: context.projectId,
    receivedAt: '2026-08-11T00:00:00.000Z',
    payloadDigest: createHash('sha256').update(payload).digest('hex'),
    signature,
    deliverySequence: sequence,
  })

  it('authenticates, deduplicates, and rejects out-of-order callbacks', async () => {
    const processor = new ProviderCallbackProcessor(
      new DigestCallbackVerifier('fixture-signature'),
      new MemoryProviderCallbackStore(),
      () => new Date('2026-08-11T00:01:00.000Z'),
    )
    expect((await processor.process(envelope('evt-1', 2), payload)).status).toBe('accepted')
    expect((await processor.process(envelope('evt-1', 2), payload)).status).toBe('duplicate')
    expect((await processor.process(envelope('evt-2', 1), payload)).status).toBe('out_of_order')
    expect(
      (await processor.process(envelope('evt-3', 3, 'invalid-signature'), payload)).status,
    ).toBe('rejected')
  })
})

describe('M06 requirement role controller boundary', () => {
  it('provides deterministic attachment scan contract evidence without reading content', async () => {
    const digest = 'a'.repeat(64)
    const attachment = {
      id: '00000000-0000-4000-8000-000000000011',
      kind: 'image' as const,
      displayName: 'reference.png',
      mediaType: 'image/png',
      sizeBytes: 120,
      digest,
      artifactRef: 'mock-artifact://reference',
      trust: 'user_supplied_untrusted' as const,
      scanStatus: 'pending' as const,
    }
    expect(await new MockAttachmentScanner().scan(attachment)).toBe('clean')
    expect(await new MockAttachmentScanner([digest]).scan(attachment)).toBe('rejected')
  })

  it('denies before any model output can be read when budget policy is unavailable', async () => {
    let outputReads = 0
    const role = new AiControlledRequirementRole(
      new MockArtifactStore(),
      new DenyAllAiCostController(),
      {
        read() {
          outputReads += 1
          return Promise.resolve({})
        },
      },
      { currency: 'USD', amount: '0.01' },
    )
    await expect(
      role.normalize({
        actor: {
          schemaVersion: '1',
          actorId: '00000000-0000-4000-8000-000000000003',
          actorType: 'user',
          authenticationMethod: 'test',
          correlationId: context.correlationId,
          issuedAt: context.requestedAt,
          organizationId: context.organizationId,
          sessionId: '00000000-0000-4000-8000-000000000009',
          subject: 'fixture:user',
        },
        changeRequest: {
          schemaVersion: '1',
          id: '00000000-0000-4000-8000-000000000010',
          organizationId: context.organizationId,
          projectId: context.projectId,
          actorId: '00000000-0000-4000-8000-000000000003',
          actorType: 'user',
          idempotencyKey: 'requirement-fixture-1',
          originalPrompt: 'Add a clear hero.',
          mode: 'builder',
          target: 'preview',
          constraints: [],
          attachments: [],
          status: 'requirements_pending',
          createdAt: context.requestedAt,
        },
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' })
    expect(outputReads).toBe(0)
  })
})
