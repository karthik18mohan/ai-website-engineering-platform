import { z } from 'zod'

import { isoTimestampSchema, opaqueIdSchema, schemaVersionV1 } from './common.js'
import { artifactReferenceV1Schema, providerRequestContextV1Schema } from './providers-v1.js'

const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/u)
const toolKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u)
const executableSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u)
const relativeWorkspacePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value === '.' ||
      (/^[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/u.test(value) &&
        !value.includes('\\') &&
        !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')),
    'Path must be normalized and relative to the workspace.',
  )

export const runnerBackendClassV1Schema = z.enum(['conformance_fixture', 'production_isolation'])

export const runnerAllowedCommandV1Schema = z
  .object({
    tool: toolKeySchema,
    executable: executableSchema,
  })
  .strict()

const runnerNetworkPolicyV1Schema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('denied') }).strict(),
  z
    .object({
      mode: z.literal('allowlist'),
      destinations: z
        .array(
          z
            .object({
              host: z
                .string()
                .trim()
                .toLowerCase()
                .regex(
                  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
                ),
              ports: z.array(z.number().int().min(1).max(65535)).min(1).max(20),
            })
            .strict(),
        )
        .min(1)
        .max(40),
    })
    .strict(),
])

export const runnerIsolationProfileV1Schema = z
  .object({
    schemaVersion: schemaVersionV1,
    id: opaqueIdSchema,
    version: z.string().trim().min(1).max(120),
    backendClass: runnerBackendClassV1Schema,
    image: z
      .object({
        reference: z.string().trim().min(1).max(512),
        digest: sha256DigestSchema,
      })
      .strict(),
    resources: z
      .object({
        cpuMillicores: z.number().int().min(50).max(32_000),
        memoryMiB: z.number().int().min(64).max(131_072),
        timeoutMs: z.number().int().min(100).max(3_600_000),
        maxProcesses: z.number().int().min(1).max(4096),
        maxFiles: z.number().int().min(1).max(1_000_000),
        maxBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    filesystem: z
      .object({
        denyHostFilesystem: z.literal(true),
        writableRoots: z.array(relativeWorkspacePathSchema).min(1).max(20),
      })
      .strict(),
    processes: z
      .object({
        shell: z.literal(false),
        allowedCommands: z.array(runnerAllowedCommandV1Schema).min(1).max(100),
      })
      .strict(),
    network: runnerNetworkPolicyV1Schema,
    dependencies: z
      .object({
        approvedRegistries: z.array(z.url()).max(20),
        installScripts: z.enum(['denied', 'allowlist']),
        allowedInstallScripts: z.array(z.string().trim().min(1).max(160)).max(40),
      })
      .strict()
      .superRefine((policy, context) => {
        if (policy.installScripts === 'denied' && policy.allowedInstallScripts.length > 0) {
          context.addIssue({
            code: 'custom',
            path: ['allowedInstallScripts'],
            message: 'Denied install scripts cannot have an allowlist.',
          })
        }
      }),
    secrets: z
      .object({
        allowProductionSecrets: z.literal(false),
        allowedReferenceKeys: z.array(z.string().trim().min(1).max(512)).max(40),
      })
      .strict(),
    artifacts: z
      .object({
        maxCount: z.number().int().min(1).max(10_000),
        maxBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        allowedMediaTypes: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
        retentionClasses: z.array(z.string().trim().min(1).max(120)).min(1).max(40),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, context) => {
    const commandKeys = profile.processes.allowedCommands.map(
      ({ tool, executable }) => `${tool}:${executable}`,
    )
    if (new Set(commandKeys).size !== commandKeys.length) {
      context.addIssue({
        code: 'custom',
        path: ['processes', 'allowedCommands'],
        message: 'Allowed commands must be unique.',
      })
    }
  })

export const runnerWorkspaceRequestV1Schema = z
  .object({
    schemaVersion: schemaVersionV1,
    context: providerRequestContextV1Schema,
    runId: opaqueIdSchema,
    executionPlanId: opaqueIdSchema,
    repository: z
      .object({
        provider: z.string().trim().min(1).max(80),
        repositoryId: z.string().trim().min(1).max(256),
      })
      .strict(),
    baseCommit: gitCommitSchema,
    profile: runnerIsolationProfileV1Schema,
  })
  .strict()

export const runnerCheckoutBundleV1Schema = z
  .object({
    schemaVersion: schemaVersionV1,
    requestId: opaqueIdSchema,
    repository: z
      .object({
        provider: z.string().trim().min(1).max(80),
        repositoryId: z.string().trim().min(1).max(256),
      })
      .strict(),
    baseCommit: gitCommitSchema,
    bundleDigest: sha256DigestSchema,
    issuedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    content: z.instanceof(Uint8Array),
  })
  .strict()

export const runnerWorkspaceV1Schema = z
  .object({
    schemaVersion: schemaVersionV1,
    id: opaqueIdSchema,
    organizationId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    runId: opaqueIdSchema,
    executionPlanId: opaqueIdSchema,
    baseCommit: gitCommitSchema,
    profileDigest: sha256DigestSchema,
    backendClass: runnerBackendClassV1Schema,
    checkoutEvidence: z
      .object({
        source: z.enum(['conformance_fixture', 'isolated_runtime']),
        commit: gitCommitSchema,
        treeDigest: sha256DigestSchema,
        detached: z.literal(true),
        clean: z.literal(true),
      })
      .strict(),
    state: z.enum(['ready', 'cancelled', 'destroyed']),
    createdAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict()

export const runnerExpectedArtifactV1Schema = z
  .object({
    path: relativeWorkspacePathSchema.refine((path) => path !== '.', {
      message: 'Expected artifact path must identify a file.',
    }),
    mediaType: z.string().trim().min(1).max(160),
    retentionClass: z.string().trim().min(1).max(120),
  })
  .strict()

export const runnerExecutionCommandV1Schema = z
  .object({
    schemaVersion: schemaVersionV1,
    context: providerRequestContextV1Schema,
    id: opaqueIdSchema,
    workspaceId: opaqueIdSchema,
    runId: opaqueIdSchema,
    baseCommit: gitCommitSchema,
    profileDigest: sha256DigestSchema,
    tool: toolKeySchema,
    executable: executableSchema,
    arguments: z.array(z.string().max(2048)).max(128),
    workingDirectory: relativeWorkspacePathSchema,
    timeoutMs: z.number().int().min(100).max(3_600_000),
    expectedArtifacts: z.array(runnerExpectedArtifactV1Schema).max(100),
  })
  .strict()
  .superRefine((command, context) => {
    const paths = command.expectedArtifacts.map(({ path }) => path)
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: 'custom',
        path: ['expectedArtifacts'],
        message: 'Expected artifact paths must be unique.',
      })
    }
  })

export const runnerArtifactEvidenceV1Schema = z
  .object({
    path: relativeWorkspacePathSchema,
    commandId: opaqueIdSchema,
    reference: artifactReferenceV1Schema,
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict()

export const runnerExecutionResultV1Schema = z
  .object({
    schemaVersion: schemaVersionV1,
    commandId: opaqueIdSchema,
    workspaceId: opaqueIdSchema,
    runId: opaqueIdSchema,
    baseCommit: gitCommitSchema,
    profileDigest: sha256DigestSchema,
    executionKind: z.enum(['simulated_conformance', 'isolated_runtime']),
    status: z.enum(['succeeded', 'failed', 'cancelled', 'rejected']),
    exitCode: z.number().int().optional(),
    rejectionCode: z
      .enum([
        'WORKSPACE_NOT_READY',
        'STALE_BINDING',
        'COMMAND_NOT_ALLOWED',
        'TIME_LIMIT_EXCEEDED',
        'OUTPUT_LIMIT_EXCEEDED',
        'FILESYSTEM_DENIED',
        'NETWORK_DENIED',
        'ARTIFACT_POLICY_DENIED',
      ])
      .optional(),
    stdoutRef: artifactReferenceV1Schema.optional(),
    stderrRef: artifactReferenceV1Schema.optional(),
    artifacts: z.array(runnerArtifactEvidenceV1Schema).max(10_000),
    startedAt: isoTimestampSchema,
    completedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === 'rejected') {
      if (result.rejectionCode === undefined || result.exitCode !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Rejected execution requires a rejection code and no exit code.',
        })
      }
      return
    }
    if (result.rejectionCode !== undefined) {
      context.addIssue({ code: 'custom', message: 'Only rejected execution has a rejection code.' })
    }
    if (
      (result.status === 'succeeded' || result.status === 'failed') &&
      result.exitCode === undefined
    ) {
      context.addIssue({ code: 'custom', message: 'Completed execution requires an exit code.' })
    }
  })

export const runnerCancellationRequestV1Schema = z
  .object({
    schemaVersion: schemaVersionV1,
    context: providerRequestContextV1Schema,
    workspaceId: opaqueIdSchema,
    runId: opaqueIdSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict()

export const runnerCleanupRequestV1Schema = z
  .object({
    schemaVersion: schemaVersionV1,
    context: providerRequestContextV1Schema,
    workspaceId: opaqueIdSchema,
    runId: opaqueIdSchema,
  })
  .strict()

export const runnerLifecycleResultV1Schema = z
  .object({
    schemaVersion: schemaVersionV1,
    workspaceId: opaqueIdSchema,
    runId: opaqueIdSchema,
    status: z.enum(['cancelled', 'already_cancelled', 'destroyed', 'already_destroyed']),
    occurredAt: isoTimestampSchema,
  })
  .strict()

export type RunnerIsolationProfileV1 = z.infer<typeof runnerIsolationProfileV1Schema>
export type RunnerWorkspaceRequestV1 = z.infer<typeof runnerWorkspaceRequestV1Schema>
export type RunnerCheckoutBundleV1 = z.infer<typeof runnerCheckoutBundleV1Schema>
export type RunnerWorkspaceV1 = z.infer<typeof runnerWorkspaceV1Schema>
export type RunnerExecutionCommandV1 = z.infer<typeof runnerExecutionCommandV1Schema>
export type RunnerExecutionResultV1 = z.infer<typeof runnerExecutionResultV1Schema>
export type RunnerCancellationRequestV1 = z.infer<typeof runnerCancellationRequestV1Schema>
export type RunnerCleanupRequestV1 = z.infer<typeof runnerCleanupRequestV1Schema>
export type RunnerLifecycleResultV1 = z.infer<typeof runnerLifecycleResultV1Schema>
