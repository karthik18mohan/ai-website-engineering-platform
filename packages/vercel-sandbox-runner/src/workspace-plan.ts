import { createHash } from 'node:crypto'

import { runnerWorkspaceRequestV1Schema, type RunnerWorkspaceRequestV1 } from '@platform/contracts'
import { PlatformError, runnerProfileDigest } from '@platform/domain'
import { z } from 'zod'

import type { VercelSandboxCreateRequest } from './sdk-client.js'
import { VERCEL_RUNNER_IMAGE_SPEC_V1, vercelRunnerImageSpecDigest } from './image-policy.js'

const SDK_VERSION = '3.0.0'
const SUPPORTED_VCPUS = new Set([1, 2, 4, 8])

export const approvedVercelSandboxImageV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    profileId: z.uuid(),
    profileVersion: z.string().min(1).max(100),
    sdkVersion: z.literal(SDK_VERSION),
    imageReference: z.string().min(1).max(1_000),
    imageDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    controls: z
      .object({
        hostFilesystemDenied: z.literal(true),
        productionSecretsAbsent: z.literal(true),
        sudoRemoved: z.literal(true),
        commandBrokerPath: z.literal('/opt/ai-website-platform/bin/runner-exec'),
        imageSpecDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        commandPaths: z
          .array(
            z
              .object({
                executable: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u),
                path: z.string().regex(/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u),
              })
              .strict(),
          )
          .min(1)
          .max(100),
        maxProcesses: z.number().int().positive(),
        maxFiles: z.number().int().positive(),
        maxBytes: z.number().int().positive(),
        installScripts: z.enum(['denied', 'allowlist']),
      })
      .strict(),
  })
  .strict()

export type ApprovedVercelSandboxImageV1 = z.infer<typeof approvedVercelSandboxImageV1Schema>

const plannedNetworkPolicySchema = z.union([
  z.literal('deny-all'),
  z.object({ allow: z.array(z.string().trim().min(1).max(253)).min(1).max(40) }).strict(),
])

export const vercelSandboxWorkspacePlanSchema = z
  .object({
    provider: z.literal('vercel_sandbox'),
    correlationId: z.uuid(),
    sdkVersion: z.literal(SDK_VERSION),
    profileDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    create: z
      .object({
        name: z.string().regex(/^awp-[a-f0-9]{32}$/u),
        image: z.string().trim().min(1).max(1_000),
        resources: z
          .object({
            vcpus: z
              .number()
              .int()
              .refine((value) => SUPPORTED_VCPUS.has(value)),
          })
          .strict(),
        timeout: z.number().int().min(100).max(3_600_000),
        networkPolicy: plannedNetworkPolicySchema,
        persistent: z.literal(false),
        ports: z.tuple([]),
        tags: z.record(z.string().min(1).max(64), z.string().max(256)),
      })
      .strict(),
    expected: z
      .object({
        image: z.string().trim().min(1).max(1_000),
        vcpus: z
          .number()
          .int()
          .refine((value) => SUPPORTED_VCPUS.has(value)),
        memoryMiB: z.number().int().positive(),
        persistent: z.literal(false),
        networkPolicy: plannedNetworkPolicySchema,
      })
      .strict(),
  })
  .strict()

export type VercelSandboxWorkspacePlan = z.infer<typeof vercelSandboxWorkspacePlanSchema>

export function planVercelSandboxWorkspace(
  rawRequest: RunnerWorkspaceRequestV1,
  approvedImages: readonly ApprovedVercelSandboxImageV1[],
): VercelSandboxWorkspacePlan {
  const request = runnerWorkspaceRequestV1Schema.parse(rawRequest)
  const images = approvedImages.map((image) => approvedVercelSandboxImageV1Schema.parse(image))
  const { profile } = request
  if (profile.backendClass !== 'production_isolation') {
    throw configurationError(request, 'Vercel Sandbox requires a production-isolation profile.')
  }

  const image = images.find(
    (candidate) =>
      candidate.profileId === profile.id && candidate.profileVersion === profile.version,
  )
  if (image === undefined) {
    throw configurationError(request, 'The runner profile has no approved Vercel image.')
  }
  assertApprovedImage(request, image)

  const vcpus = profile.resources.cpuMillicores / 1000
  if (!Number.isInteger(vcpus) || !SUPPORTED_VCPUS.has(vcpus)) {
    throw configurationError(request, 'Vercel Sandbox requires 1, 2, 4, or 8 whole vCPUs.')
  }
  if (profile.resources.memoryMiB !== vcpus * 2048) {
    throw configurationError(request, 'Vercel Sandbox provides exactly 2048 MiB per vCPU.')
  }
  if (
    image.controls.maxProcesses !== profile.resources.maxProcesses ||
    image.controls.maxFiles !== profile.resources.maxFiles ||
    image.controls.maxBytes !== profile.resources.maxBytes ||
    image.controls.installScripts !== profile.dependencies.installScripts ||
    image.controls.installScripts !== 'denied' ||
    profile.resources.timeoutMs !== VERCEL_RUNNER_IMAGE_SPEC_V1.controls.maxTimeoutMs ||
    profile.resources.maxProcesses !== VERCEL_RUNNER_IMAGE_SPEC_V1.controls.maxProcesses ||
    profile.resources.maxFiles !== VERCEL_RUNNER_IMAGE_SPEC_V1.controls.maxFiles ||
    profile.resources.maxBytes !== VERCEL_RUNNER_IMAGE_SPEC_V1.controls.maxBytes ||
    JSON.stringify(profile.dependencies.approvedRegistries) !==
      JSON.stringify(VERCEL_RUNNER_IMAGE_SPEC_V1.approvedRegistries) ||
    !profile.processes.allowedCommands.every(({ executable }) =>
      image.controls.commandPaths.some((candidate) => candidate.executable === executable),
    )
  ) {
    throw configurationError(
      request,
      'The approved image hardening controls do not match the profile.',
    )
  }

  const networkPolicy = toNetworkPolicy(request)
  const profileDigest = runnerProfileDigest(profile)
  const name = `awp-${createHash('sha256')
    .update(
      `${request.context.organizationId}:${request.context.projectId}:${request.runId}:${request.context.idempotencyKey}`,
    )
    .digest('hex')
    .slice(0, 32)}`

  return vercelSandboxWorkspacePlanSchema.parse({
    provider: 'vercel_sandbox',
    correlationId: request.context.correlationId,
    sdkVersion: SDK_VERSION,
    profileDigest,
    create: {
      name,
      image: image.imageReference,
      resources: { vcpus },
      timeout: profile.resources.timeoutMs,
      networkPolicy,
      persistent: false,
      ports: [],
      tags: {
        profile: profileDigest.slice(0, 24),
        run: request.runId.replaceAll('-', '').slice(0, 24),
      },
    },
    expected: {
      image: image.imageReference,
      vcpus,
      memoryMiB: profile.resources.memoryMiB,
      persistent: false,
      networkPolicy,
    },
  })
}

function assertApprovedImage(
  request: RunnerWorkspaceRequestV1,
  image: ApprovedVercelSandboxImageV1,
): void {
  const digestReference = `@sha256:${image.imageDigest}`
  if (
    image.sdkVersion !== SDK_VERSION ||
    image.imageReference !== request.profile.image.reference ||
    image.imageDigest !== request.profile.image.digest ||
    !image.imageReference.endsWith(digestReference) ||
    !image.controls.hostFilesystemDenied ||
    !image.controls.productionSecretsAbsent ||
    !image.controls.sudoRemoved ||
    image.controls.commandBrokerPath !== '/opt/ai-website-platform/bin/runner-exec' ||
    image.controls.imageSpecDigest !== vercelRunnerImageSpecDigest() ||
    JSON.stringify(image.controls.commandPaths) !==
      JSON.stringify(VERCEL_RUNNER_IMAGE_SPEC_V1.commandPaths)
  ) {
    throw configurationError(request, 'The approved Vercel image identity or hardening is invalid.')
  }
}

function toNetworkPolicy(
  request: RunnerWorkspaceRequestV1,
): VercelSandboxCreateRequest['networkPolicy'] {
  if (request.profile.network.mode === 'denied') return 'deny-all'
  if (
    request.profile.network.destinations.some(({ ports }) => ports.some((port) => port !== 443))
  ) {
    throw configurationError(
      request,
      'The Vercel domain allowlist profile supports HTTPS destination port 443 only.',
    )
  }
  return { allow: request.profile.network.destinations.map(({ host }) => host) }
}

function configurationError(request: RunnerWorkspaceRequestV1, safeMessage: string): PlatformError {
  return new PlatformError({
    code: 'CONFIGURATION_INVALID',
    correlationId: request.context.correlationId,
    retryable: false,
    safeMessage,
  })
}
