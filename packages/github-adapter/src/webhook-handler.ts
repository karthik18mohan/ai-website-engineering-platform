import { createHash } from 'node:crypto'

import {
  providerCallbackEnvelopeV1Schema,
  type CallbackProcessingResultV1,
  type ProviderCallbackEnvelopeV1,
} from '@platform/contracts'
import type { ProviderCallbackProcessor } from '@platform/domain'
import { z } from 'zod'

import type { GithubWebhookVerifier } from './webhook-verifier.js'

const supportedEventSchema = z.enum(['installation', 'installation_repositories', 'push'])
const payloadIdentitySchema = z
  .object({
    installation: z.object({ id: z.number().int().positive() }),
    repository: z.object({ id: z.number().int().positive() }).optional(),
  })
  .passthrough()

export interface GithubWebhookContext {
  readonly organizationId: string
  readonly projectId: string
  readonly actorRef: `service:${string}`
}

export interface GithubWebhookContextResolver {
  resolve(
    installationId: string,
    repositoryId: string | undefined,
  ): Promise<readonly GithubWebhookContext[]>
}

export interface GithubWebhookDelivery {
  readonly deliveryId: string
  readonly eventType: string
  readonly signature: string
}

export class GithubWebhookHandler {
  constructor(
    private readonly verifier: GithubWebhookVerifier,
    private readonly processor: ProviderCallbackProcessor,
    private readonly resolver: GithubWebhookContextResolver,
    private readonly onAccepted: (
      context: GithubWebhookContext,
      eventType: 'installation' | 'installation_repositories' | 'push',
    ) => Promise<void> = () => Promise.resolve(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async handle(
    delivery: GithubWebhookDelivery,
    payload: Uint8Array,
  ): Promise<readonly CallbackProcessingResultV1[]> {
    const eventType = supportedEventSchema.parse(delivery.eventType)
    if (!this.verifier.verifySignature(delivery.signature, payload)) {
      return [this.result(delivery.deliveryId, 'rejected')]
    }
    const identity = payloadIdentitySchema.parse(JSON.parse(new TextDecoder().decode(payload)))
    const contexts = await this.resolver.resolve(
      String(identity.installation.id),
      identity.repository === undefined ? undefined : String(identity.repository.id),
    )
    if (contexts.length === 0) return [this.result(delivery.deliveryId, 'rejected')]

    const results: CallbackProcessingResultV1[] = []
    for (const context of contexts) {
      const envelope = this.envelope(delivery, eventType, context, payload)
      const result = await this.processor.process(envelope, payload)
      results.push(result)
      if (result.status === 'accepted') await this.onAccepted(context, eventType)
    }
    return results
  }

  private envelope(
    delivery: GithubWebhookDelivery,
    eventType: 'installation' | 'installation_repositories' | 'push',
    context: GithubWebhookContext,
    payload: Uint8Array,
  ): ProviderCallbackEnvelopeV1 {
    return providerCallbackEnvelopeV1Schema.parse({
      schemaVersion: '1',
      provider: 'github',
      externalEventId: delivery.deliveryId,
      eventType,
      actorRef: context.actorRef,
      organizationId: context.organizationId,
      projectId: context.projectId,
      receivedAt: this.clock().toISOString(),
      payloadDigest: createHash('sha256').update(payload).digest('hex'),
      signature: delivery.signature,
    })
  }

  private result(
    externalEventId: string,
    status: CallbackProcessingResultV1['status'],
  ): CallbackProcessingResultV1 {
    return {
      schemaVersion: '1',
      externalEventId,
      status,
      processedAt: this.clock().toISOString(),
    }
  }
}
