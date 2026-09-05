import { z } from 'zod'

const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/u)
const requestIdSchema = z.uuid()
const executableSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u)
const toolSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u)
const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value === '.' ||
      (/^[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/u.test(value) &&
        !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')),
    'Path must be normalized and relative.',
  )

const brokerEnvelopeV1Schema = z.object({ schemaVersion: z.literal('1') }).strict()

export const runnerBrokerCheckoutRequestV1Schema = brokerEnvelopeV1Schema.extend({
  action: z.literal('checkout'),
  requestId: requestIdSchema,
  bundlePath: z.string().regex(/^\/home\/runner\/\.platform-control\/[a-f0-9-]{36}\.bundle$/u),
  bundleDigest: sha256DigestSchema,
  baseCommit: gitCommitSchema,
})

export const runnerBrokerExecuteRequestV1Schema = brokerEnvelopeV1Schema.extend({
  action: z.literal('execute'),
  requestId: requestIdSchema,
  commandId: requestIdSchema,
  tool: toolSchema,
  executable: executableSchema,
  arguments: z.array(z.string().max(2048)).max(128),
  workingDirectory: relativePathSchema,
  timeoutMs: z.number().int().min(100).max(3_600_000),
  limits: z
    .object({
      maxProcesses: z.number().int().min(1).max(4096),
      maxFiles: z.number().int().min(1).max(1_000_000),
      maxBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  artifacts: z
    .object({
      expectedPaths: z
        .array(relativePathSchema.refine((path) => path !== '.'))
        .max(100)
        .refine((paths) => new Set(paths).size === paths.length, 'Artifact paths must be unique.'),
      maxCount: z.number().int().min(1).max(10_000),
      maxBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  installScripts: z.literal('denied'),
})

export const runnerBrokerRequestV1Schema = z.discriminatedUnion('action', [
  runnerBrokerCheckoutRequestV1Schema,
  runnerBrokerExecuteRequestV1Schema,
])

const brokerResultV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    requestId: requestIdSchema,
    action: z.enum(['checkout', 'execute']),
    status: z.enum(['succeeded', 'failed', 'rejected']),
    failureCode: z
      .enum([
        'BROKER_REQUEST_INVALID',
        'BUNDLE_DIGEST_MISMATCH',
        'CHECKOUT_FAILED',
        'COMMAND_NOT_ALLOWED',
        'FILESYSTEM_LIMIT_EXCEEDED',
        'OUTPUT_LIMIT_EXCEEDED',
        'TIME_LIMIT_EXCEEDED',
        'COMMAND_FAILED',
        'ARTIFACT_CAPTURE_FAILED',
      ])
      .optional(),
  })
  .strict()

export const runnerBrokerCheckoutResultV1Schema = brokerResultV1Schema.extend({
  action: z.literal('checkout'),
  commit: gitCommitSchema.optional(),
  treeDigest: sha256DigestSchema.optional(),
  detached: z.boolean().optional(),
  clean: z.boolean().optional(),
})

export const runnerBrokerExecuteResultV1Schema = brokerResultV1Schema.extend({
  action: z.literal('execute'),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  stdoutDigest: sha256DigestSchema.optional(),
  stderrDigest: sha256DigestSchema.optional(),
  stdoutBytes: z.number().int().nonnegative().optional(),
  stderrBytes: z.number().int().nonnegative().optional(),
  artifacts: z
    .array(
      z
        .object({
          path: relativePathSchema.refine((path) => path !== '.'),
          digest: sha256DigestSchema,
          sizeBytes: z.number().int().nonnegative(),
        })
        .strict(),
    )
    .max(100)
    .optional(),
})

export const runnerBrokerResultV1Schema = z
  .discriminatedUnion('action', [
    runnerBrokerCheckoutResultV1Schema,
    runnerBrokerExecuteResultV1Schema,
  ])
  .superRefine((result, context) => {
    const failed = result.status !== 'succeeded'
    if (failed !== (result.failureCode !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Failure status and failure code must be present together.',
        path: ['failureCode'],
      })
    }

    if (result.action === 'checkout') {
      const hasEvidence =
        result.commit !== undefined &&
        result.treeDigest !== undefined &&
        result.detached === true &&
        result.clean === true
      if ((result.status === 'succeeded') !== hasEvidence) {
        context.addIssue({
          code: 'custom',
          message: 'Successful checkout requires complete immutable-checkout evidence.',
        })
      }
      return
    }

    const hasExecutionEvidence =
      result.exitCode !== undefined &&
      result.durationMs !== undefined &&
      result.stdoutDigest !== undefined &&
      result.stderrDigest !== undefined &&
      result.stdoutBytes !== undefined &&
      result.stderrBytes !== undefined
    if ((result.status !== 'rejected') !== hasExecutionEvidence) {
      context.addIssue({
        code: 'custom',
        message: 'Accepted execution requires complete bounded-output evidence.',
      })
    }
    if (result.status !== 'rejected' && result.artifacts === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Accepted execution requires artifact capture evidence.',
      })
    }
  })

export type RunnerBrokerRequestV1 = z.infer<typeof runnerBrokerRequestV1Schema>
export type RunnerBrokerCheckoutRequestV1 = z.infer<typeof runnerBrokerCheckoutRequestV1Schema>
export type RunnerBrokerExecuteRequestV1 = z.infer<typeof runnerBrokerExecuteRequestV1Schema>
export type RunnerBrokerResultV1 = z.infer<typeof runnerBrokerResultV1Schema>
export type RunnerBrokerCheckoutResultV1 = z.infer<typeof runnerBrokerCheckoutResultV1Schema>
export type RunnerBrokerExecuteResultV1 = z.infer<typeof runnerBrokerExecuteResultV1Schema>
