import { createHash, createHmac } from 'node:crypto'

import type {
  ActorContextV1,
  GithubRepositoryMetadataV1,
  ProjectV1,
  ProviderCallbackEnvelopeV1,
} from '@platform/contracts'
import { GithubOnboardingService, PlatformError, ProviderCallbackProcessor } from '@platform/domain'
import { MemoryProviderCallbackStore, MockSecretsAdapter } from '@platform/provider-framework'
import { describe, expect, it } from 'vitest'

import { GithubAppAdapter } from './github-app-adapter.js'
import { MemoryGithubOnboardingStore, MockGithubInstallationClient } from './mock-github.js'
import { GithubWebhookHandler } from './webhook-handler.js'
import { GithubWebhookVerifier } from './webhook-verifier.js'

const organizationId = '00000000-0000-4000-8000-000000000010'
const projectId = '00000000-0000-4000-8000-000000000011'
const actorId = '00000000-0000-4000-8000-000000000012'
const actor: ActorContextV1 = {
  schemaVersion: '1',
  actorId,
  actorType: 'user',
  authenticationMethod: 'test',
  correlationId: '00000000-0000-4000-8000-000000000013',
  issuedAt: '2026-08-11T00:00:00.000Z',
  organizationId,
  sessionId: '00000000-0000-4000-8000-000000000014',
  subject: 'test:owner',
}
const project: ProjectV1 = {
  schemaVersion: '1',
  id: projectId,
  organizationId,
  name: 'Fixture website',
  slug: 'fixture-website',
  pluginType: 'website',
  policyId: '00000000-0000-4000-8000-000000000015',
  status: 'active',
  createdAt: '2026-08-11T00:00:00.000Z',
  updatedAt: '2026-08-11T00:00:00.000Z',
}
const credentialRef = {
  schemaVersion: '1' as const,
  provider: 'mock-vault',
  key: 'github/apps/platform/private-key',
}
const metadata: GithubRepositoryMetadataV1 = {
  schemaVersion: '1',
  installationId: '101',
  repositoryId: '202',
  owner: 'fixture-owner',
  name: 'fixture-repository',
  defaultBranch: 'main',
  indexedCommit: 'a'.repeat(40),
  permissions: { metadata: 'read', contents: 'read', pullRequests: 'write' },
}

function fixture(
  options: { role?: 'owner' | 'viewer'; repository?: GithubRepositoryMetadataV1 } = {},
) {
  const store = new MemoryGithubOnboardingStore()
  store.projects.set(`${organizationId}:${projectId}`, project)
  store.memberships.set(`${organizationId}:${actorId}`, {
    actorId,
    organizationId,
    role: options.role ?? 'owner',
    status: 'active',
  })
  const secrets = new MockSecretsAdapter()
  secrets.register(credentialRef)
  const client = new MockGithubInstallationClient(options.repository ?? metadata)
  let now = new Date('2026-08-11T00:00:00.000Z')
  let id = 20
  const service = new GithubOnboardingService({
    adapter: new GithubAppAdapter('platform-fixture', client),
    appCredentialRef: credentialRef,
    clock: () => now,
    idFactory: () => `00000000-0000-4000-8000-${String(id++).padStart(12, '0')}`,
    secrets,
    stateFactory: () => 'fixture-state-value-with-more-than-32-characters',
    store,
  })
  return { client, service, store, setNow: (value: string) => (now = new Date(value)) }
}

async function initiate(service: GithubOnboardingService) {
  return service.initiate(actor, {
    schemaVersion: '1',
    organizationId,
    projectId,
    returnUrl: 'https://platform.example.invalid/settings/integrations',
  })
}

describe('M04 GitHub App onboarding contract', () => {
  it('connects a permitted fixture repository at a known immutable commit without exposing credentials', async () => {
    const { service, store } = fixture()
    const initiated = await initiate(service)
    const state = new URL(initiated.authorizationUrl).searchParams.get('state')
    expect(state).toBe('fixture-state-value-with-more-than-32-characters')
    expect(store.attempts.get(initiated.attemptId)?.stateDigest).toBe(
      createHash('sha256').update(state!).digest('hex'),
    )
    expect(JSON.stringify(initiated)).not.toMatch(/private|credential|token|secret/iu)

    const connected = await service.complete(actor, {
      schemaVersion: '1',
      organizationId,
      projectId,
      attemptId: initiated.attemptId,
      state: state!,
      installationId: metadata.installationId,
      repositoryId: metadata.repositoryId,
    })

    expect(connected).toMatchObject({
      readiness: 'ready',
      defaultBranch: 'main',
      indexedCommit: 'a'.repeat(40),
      mutationEnabled: false,
      metadata: { detectionStatus: 'pending' },
    })
    expect(connected.appCredentialRef).toEqual(credentialRef)
    expect(store.audits.map(({ action }) => action)).toContain('github.repository_connected')
  })

  it('rejects expired/replayed state and users without repository connection authority', async () => {
    const expired = fixture()
    const initiated = await initiate(expired.service)
    const state = new URL(initiated.authorizationUrl).searchParams.get('state')!
    expired.setNow('2026-08-11T00:11:00.000Z')
    await expect(
      expired.service.complete(actor, {
        schemaVersion: '1',
        organizationId,
        projectId,
        attemptId: initiated.attemptId,
        state,
        installationId: '101',
        repositoryId: '202',
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' })

    await expect(initiate(fixture({ role: 'viewer' }).service)).rejects.toBeInstanceOf(
      PlatformError,
    )
  })

  it('surfaces insufficient scope and lost installation access without enabling mutation', async () => {
    const insufficient = fixture({
      repository: {
        ...metadata,
        permissions: { metadata: 'read', contents: 'none', pullRequests: 'none' },
      },
    })
    const initiated = await initiate(insufficient.service)
    const state = new URL(initiated.authorizationUrl).searchParams.get('state')!
    const connected = await insufficient.service.complete(actor, {
      schemaVersion: '1',
      organizationId,
      projectId,
      attemptId: initiated.attemptId,
      state,
      installationId: '101',
      repositoryId: '202',
    })
    expect(connected).toMatchObject({
      readiness: 'insufficient_permissions',
      mutationEnabled: false,
    })

    const ready = fixture()
    const readyAttempt = await initiate(ready.service)
    await ready.service.complete(actor, {
      schemaVersion: '1',
      organizationId,
      projectId,
      attemptId: readyAttempt.attemptId,
      state: new URL(readyAttempt.authorizationUrl).searchParams.get('state')!,
      installationId: '101',
      repositoryId: '202',
    })
    ready.client.accessible = false
    ready.setNow('2026-08-11T00:05:00.000Z')
    expect(await ready.service.refreshAccess(actor, organizationId, projectId)).toMatchObject({
      readiness: 'access_lost',
      mutationEnabled: false,
    })
  })
})

describe('M04 GitHub webhook safety', () => {
  it.each(['installation', 'installation_repositories', 'push'] as const)(
    'resolves trusted tenant context and processes raw %s payloads',
    async (eventType) => {
      const secret = new TextEncoder().encode('fixture-webhook-secret')
      const payload = new TextEncoder().encode(
        JSON.stringify({ installation: { id: 101 }, repository: { id: 202 } }),
      )
      const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`
      const verifier = new GithubWebhookVerifier(secret)
      const accepted: string[] = []
      const handler = new GithubWebhookHandler(
        verifier,
        new ProviderCallbackProcessor(
          verifier,
          new MemoryProviderCallbackStore(),
          () => new Date('2026-08-11T00:01:00.000Z'),
        ),
        {
          resolve(installationId, repositoryId) {
            expect({ installationId, repositoryId }).toEqual({
              installationId: '101',
              repositoryId: '202',
            })
            return Promise.resolve([
              {
                organizationId,
                projectId,
                actorRef: 'service:00000000-0000-4000-8000-000000000099' as const,
              },
            ])
          },
        },
        (_context, acceptedEvent) => {
          accepted.push(acceptedEvent)
          return Promise.resolve()
        },
        () => new Date('2026-08-11T00:00:00.000Z'),
      )
      const delivery = {
        deliveryId: `raw-${eventType}`,
        eventType,
        signature,
      }
      expect(await handler.handle(delivery, payload)).toEqual([
        expect.objectContaining({ status: 'accepted' }),
      ])
      expect(await handler.handle(delivery, payload)).toEqual([
        expect.objectContaining({ status: 'duplicate' }),
      ])
      expect(accepted).toEqual([eventType])
    },
  )

  it.each(['installation', 'installation_repositories', 'push'] as const)(
    'authenticates and deduplicates %s deliveries',
    async (eventType) => {
      const secret = new TextEncoder().encode('fixture-webhook-secret')
      const payload = new TextEncoder().encode(`{"event":"${eventType}"}`)
      const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`
      const envelope: ProviderCallbackEnvelopeV1 = {
        schemaVersion: '1',
        provider: 'github',
        externalEventId: `${eventType}-delivery`,
        eventType,
        actorRef: 'service:00000000-0000-4000-8000-000000000099',
        organizationId,
        projectId,
        receivedAt: '2026-08-11T00:00:00.000Z',
        payloadDigest: createHash('sha256').update(payload).digest('hex'),
        signature,
        deliverySequence: 1,
      }
      const processor = new ProviderCallbackProcessor(
        new GithubWebhookVerifier(secret),
        new MemoryProviderCallbackStore(),
        () => new Date('2026-08-11T00:01:00.000Z'),
      )
      expect((await processor.process(envelope, payload)).status).toBe('accepted')
      expect((await processor.process(envelope, payload)).status).toBe('duplicate')
    },
  )

  it('rejects out-of-order and invalid deliveries', async () => {
    const secret = new TextEncoder().encode('fixture-webhook-secret')
    const payload = new TextEncoder().encode('{"ref":"refs/heads/main"}')
    const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`
    const envelope = (
      id: string,
      sequence: number,
      candidate = signature,
    ): ProviderCallbackEnvelopeV1 => ({
      schemaVersion: '1',
      provider: 'github',
      externalEventId: id,
      eventType: 'push',
      actorRef: 'service:00000000-0000-4000-8000-000000000099',
      organizationId,
      projectId,
      receivedAt: '2026-08-11T00:00:00.000Z',
      payloadDigest: createHash('sha256').update(payload).digest('hex'),
      signature: candidate,
      deliverySequence: sequence,
    })
    const processor = new ProviderCallbackProcessor(
      new GithubWebhookVerifier(secret),
      new MemoryProviderCallbackStore(),
      () => new Date('2026-08-11T00:01:00.000Z'),
    )
    expect((await processor.process(envelope('delivery-1', 2), payload)).status).toBe('accepted')
    expect((await processor.process(envelope('delivery-1', 2), payload)).status).toBe('duplicate')
    expect((await processor.process(envelope('delivery-2', 1), payload)).status).toBe(
      'out_of_order',
    )
    expect(
      (await processor.process(envelope('delivery-3', 3, 'sha256=invalid'), payload)).status,
    ).toBe('rejected')
  })
})
