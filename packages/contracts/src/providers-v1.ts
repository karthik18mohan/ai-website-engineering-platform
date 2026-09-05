import { z } from 'zod'
import {
  correlationIdSchema,
  isoTimestampSchema,
  opaqueIdSchema,
  schemaVersionV1,
} from './common.js'

export const providerKindV1Schema = z.enum([
  'secrets',
  'git',
  'deployment',
  'model',
  'artifacts',
  'runner',
  'orchestration',
])
export const providerOperationStatusV1Schema = z.enum(['succeeded', 'rejected', 'unavailable'])

export const providerRequestContextV1Schema = z.object({
  schemaVersion: schemaVersionV1,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  actorRef: z.string().regex(/^(?:user|service):[0-9a-f-]{36}$/u),
  correlationId: correlationIdSchema,
  idempotencyKey: z.string().min(8).max(256),
  requestedAt: isoTimestampSchema,
})

export const secretReferenceV1Schema = z
  .object({
    schemaVersion: schemaVersionV1,
    provider: z.string().min(1).max(80),
    key: z.string().min(1).max(512),
    version: z.string().min(1).max(160).optional(),
  })
  .strict()

export const providerErrorV1Schema = z.object({
  schemaVersion: schemaVersionV1,
  code: z.enum([
    'AUTHENTICATION_FAILED',
    'FORBIDDEN',
    'NOT_FOUND',
    'RATE_LIMITED',
    'UNAVAILABLE',
    'INVALID_RESPONSE',
  ]),
  retryable: z.boolean(),
  safeMessage: z.string().min(1).max(500),
})

export const providerCallbackEnvelopeV1Schema = z.object({
  schemaVersion: schemaVersionV1,
  provider: z.string().min(1).max(80),
  externalEventId: z.string().min(1).max(256),
  eventType: z.string().min(1).max(160),
  actorRef: z.string().regex(/^service:[0-9a-f-]{36}$/u),
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  receivedAt: isoTimestampSchema,
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  signature: z.string().min(1).max(2048),
  deliverySequence: z.number().int().nonnegative().optional(),
})

export const callbackProcessingResultV1Schema = z.object({
  schemaVersion: schemaVersionV1,
  externalEventId: z.string().min(1).max(256),
  status: z.enum(['accepted', 'duplicate', 'rejected', 'out_of_order']),
  processedAt: isoTimestampSchema,
})

export const gitRepositoryRefV1Schema = z.object({
  provider: z.string().min(1),
  repositoryId: z.string().min(1),
  defaultBranch: z.string().min(1),
})
export const deploymentRequestV1Schema = z.object({
  context: providerRequestContextV1Schema,
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  environment: z.literal('preview'),
})
export const deploymentResultV1Schema = z.object({
  schemaVersion: schemaVersionV1,
  providerDeploymentId: z.string().min(1),
  status: z.enum(['queued', 'building', 'ready', 'failed']),
  url: z.url().optional(),
})
export const artifactReferenceV1Schema = z.object({
  schemaVersion: schemaVersionV1,
  uri: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  mediaType: z.string().min(1),
  retentionClass: z.string().min(1),
})
export const aiInvocationRequestV1Schema = z.object({
  schemaVersion: schemaVersionV1,
  context: providerRequestContextV1Schema,
  requestType: z.string().min(1).max(160),
  inputRef: artifactReferenceV1Schema,
  capability: z.string().min(1).max(160),
  dataClassification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  maximumCost: z.object({
    currency: z.string().length(3),
    amount: z.string().regex(/^\d+(?:\.\d{1,8})?$/u),
  }),
})

export const aiInvocationResultV1Schema = z.object({
  schemaVersion: schemaVersionV1,
  outputRef: artifactReferenceV1Schema,
  estimateId: opaqueIdSchema,
  budgetDecisionId: opaqueIdSchema,
  routingDecisionId: opaqueIdSchema,
  pricingVersion: z.string().min(1).max(160),
  usageRecordId: opaqueIdSchema,
  reconciliationStatus: z.enum(['pending', 'reconciled']),
})

export type ProviderRequestContextV1 = z.infer<typeof providerRequestContextV1Schema>
export type SecretReferenceV1 = z.infer<typeof secretReferenceV1Schema>
export type ProviderCallbackEnvelopeV1 = z.infer<typeof providerCallbackEnvelopeV1Schema>
export type CallbackProcessingResultV1 = z.infer<typeof callbackProcessingResultV1Schema>
export type GitRepositoryRefV1 = z.infer<typeof gitRepositoryRefV1Schema>
export type DeploymentRequestV1 = z.infer<typeof deploymentRequestV1Schema>
export type DeploymentResultV1 = z.infer<typeof deploymentResultV1Schema>
export type ArtifactReferenceV1 = z.infer<typeof artifactReferenceV1Schema>
export type AiInvocationRequestV1 = z.infer<typeof aiInvocationRequestV1Schema>
export type AiInvocationResultV1 = z.infer<typeof aiInvocationResultV1Schema>
