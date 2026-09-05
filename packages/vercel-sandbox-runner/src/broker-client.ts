import { createHash } from 'node:crypto'

import {
  runnerExecutionCommandV1Schema,
  runnerIsolationProfileV1Schema,
  runnerWorkspaceV1Schema,
  type CorrelationId,
  type RunnerExecutionCommandV1,
  type RunnerIsolationProfileV1,
  type RunnerWorkspaceV1,
} from '@platform/contracts'
import { evaluateRunnerCommand, PlatformError } from '@platform/domain'
import { z } from 'zod'

import {
  runnerBrokerCheckoutRequestV1Schema,
  runnerBrokerExecuteRequestV1Schema,
  runnerBrokerResultV1Schema,
  type RunnerBrokerCheckoutResultV1,
  type RunnerBrokerExecuteRequestV1,
  type RunnerBrokerExecuteResultV1,
  type RunnerBrokerRequestV1,
  type RunnerBrokerResultV1,
} from './broker-protocol.js'
import { VERCEL_RUNNER_IMAGE_SPEC_V1 } from './image-policy.js'
import type { VercelSandboxHandle } from './sdk-client.js'

const MAX_BUNDLE_BYTES = 1_073_741_824
const MAX_BUNDLE_LIFETIME_MS = 300_000
const MAX_BROKER_RESPONSE_BYTES = 65_536
const CONTROL_FILE_MODE = 0o600

export const vercelCheckoutBundleMetadataV1Schema = z
  .object({
    schemaVersion: z.literal('1'),
    requestId: z.uuid(),
    bundleDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()

export type VercelCheckoutBundleMetadataV1 = z.infer<typeof vercelCheckoutBundleMetadataV1Schema>

export interface VercelCheckoutBundleV1 extends VercelCheckoutBundleMetadataV1 {
  readonly content: Uint8Array
}

export interface VercelSandboxBrokerClientOptions {
  readonly clock?: () => Date
}

export interface VercelBrokerExecutionInput {
  readonly workspace: RunnerWorkspaceV1
  readonly profile: RunnerIsolationProfileV1
  readonly command: RunnerExecutionCommandV1
}

export class VercelSandboxBrokerClient {
  readonly #clock: () => Date

  constructor(options: VercelSandboxBrokerClientOptions = {}) {
    this.#clock = options.clock ?? (() => new Date())
  }

  async checkout(
    handle: VercelSandboxHandle,
    bundle: VercelCheckoutBundleV1,
    correlationId: CorrelationId,
    signal?: AbortSignal,
  ): Promise<RunnerBrokerCheckoutResultV1> {
    const now = this.#clock().getTime()
    let request
    try {
      request = this.#checkoutRequest(bundle, correlationId, now)
    } catch (cause) {
      if (cause instanceof PlatformError) throw cause
      throw new PlatformError({
        code: 'VALIDATION_FAILED',
        correlationId,
        retryable: false,
        safeMessage: 'The checkout bundle envelope is invalid.',
        cause,
      })
    }
    const controlPath = this.#controlPath(request.requestId)
    const signalOptions = signal === undefined ? undefined : { signal }
    try {
      await handle.writeFiles(
        [
          { path: request.bundlePath, content: bundle.content, mode: CONTROL_FILE_MODE },
          { path: controlPath, content: JSON.stringify(request), mode: CONTROL_FILE_MODE },
        ],
        signalOptions,
      )
    } catch (cause) {
      await safeStop(handle)
      throw dependencyError(
        correlationId,
        'The sandbox checkout bundle could not be staged.',
        cause,
      )
    }
    return this.#invoke(
      handle,
      request,
      controlPath,
      Math.min(
        VERCEL_RUNNER_IMAGE_SPEC_V1.controls.maxTimeoutMs,
        Date.parse(bundle.expiresAt) - now,
      ),
      correlationId,
      signal,
    )
  }

  async execute(
    handle: VercelSandboxHandle,
    input: VercelBrokerExecutionInput,
    signal?: AbortSignal,
  ): Promise<RunnerBrokerExecuteResultV1> {
    const parsed: RunnerBrokerExecuteRequestV1 = planVercelBrokerExecution(input)
    const correlationId = input.command.context.correlationId
    const controlPath = this.#controlPath(parsed.requestId)
    const signalOptions = signal === undefined ? undefined : { signal }
    try {
      await handle.writeFiles(
        [{ path: controlPath, content: JSON.stringify(parsed), mode: CONTROL_FILE_MODE }],
        signalOptions,
      )
    } catch (cause) {
      await safeStop(handle)
      throw dependencyError(
        correlationId,
        'The sandbox command envelope could not be staged.',
        cause,
      )
    }
    return this.#invoke(handle, parsed, controlPath, parsed.timeoutMs, correlationId, signal)
  }

  #checkoutRequest(
    rawBundle: VercelCheckoutBundleV1,
    correlationId: CorrelationId,
    now: number,
  ): ReturnType<typeof runnerBrokerCheckoutRequestV1Schema.parse> {
    const { content, ...rawMetadata } = rawBundle
    const metadata = vercelCheckoutBundleMetadataV1Schema.parse(rawMetadata)
    const issuedAt = Date.parse(metadata.issuedAt)
    const expiresAt = Date.parse(metadata.expiresAt)
    if (
      !(content instanceof Uint8Array) ||
      content.byteLength === 0 ||
      content.byteLength > MAX_BUNDLE_BYTES ||
      issuedAt > now ||
      expiresAt <= now ||
      expiresAt - issuedAt > MAX_BUNDLE_LIFETIME_MS ||
      createHash('sha256').update(content).digest('hex') !== metadata.bundleDigest
    ) {
      throw new PlatformError({
        code: 'VALIDATION_FAILED',
        correlationId,
        retryable: false,
        safeMessage: 'The checkout bundle failed freshness, size, or digest validation.',
      })
    }

    return runnerBrokerCheckoutRequestV1Schema.parse({
      schemaVersion: '1',
      action: 'checkout',
      requestId: metadata.requestId,
      bundlePath: `${VERCEL_RUNNER_IMAGE_SPEC_V1.controlRoot}/${metadata.requestId}.bundle`,
      bundleDigest: metadata.bundleDigest,
      baseCommit: metadata.baseCommit,
    })
  }

  async #invoke<TRequest extends RunnerBrokerRequestV1>(
    handle: VercelSandboxHandle,
    request: TRequest,
    controlPath: string,
    timeoutMs: number,
    correlationId: CorrelationId,
    signal?: AbortSignal,
  ): Promise<
    TRequest['action'] extends 'checkout'
      ? RunnerBrokerCheckoutResultV1
      : RunnerBrokerExecuteResultV1
  > {
    let command
    try {
      command = await handle.runCommand({
        cmd: VERCEL_RUNNER_IMAGE_SPEC_V1.commandBrokerPath,
        args: [controlPath],
        env: {},
        sudo: true,
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (cause) {
      await safeStop(handle)
      throw dependencyError(
        correlationId,
        'The sandbox broker command could not be started.',
        cause,
      )
    }

    try {
      const [stdout, stderr] = await Promise.all([
        command.stdout(signal === undefined ? undefined : { signal }),
        command.stderr(signal === undefined ? undefined : { signal }),
      ])
      if (
        command.exitCode !== 0 ||
        stderr.trim().length > 0 ||
        Buffer.byteLength(stdout, 'utf8') > MAX_BROKER_RESPONSE_BYTES
      ) {
        throw new Error('Broker command output was not a successful bounded response.')
      }
      const rawResult: unknown = JSON.parse(stdout.trim())
      const result: RunnerBrokerResultV1 = runnerBrokerResultV1Schema.parse(rawResult)
      if (result.requestId !== request.requestId || result.action !== request.action) {
        throw new Error('Broker result binding did not match its request.')
      }
      return result as TRequest['action'] extends 'checkout'
        ? RunnerBrokerCheckoutResultV1
        : RunnerBrokerExecuteResultV1
    } catch (cause) {
      await safeStop(handle)
      throw new PlatformError({
        code: 'VALIDATION_FAILED',
        correlationId,
        retryable: false,
        safeMessage: 'The sandbox broker returned invalid execution evidence.',
        cause,
      })
    }
  }

  #controlPath(requestId: string): string {
    return `${VERCEL_RUNNER_IMAGE_SPEC_V1.controlRoot}/${requestId}.json`
  }
}

export function planVercelBrokerExecution(
  input: VercelBrokerExecutionInput,
): RunnerBrokerExecuteRequestV1 {
  const workspace = runnerWorkspaceV1Schema.parse(input.workspace)
  const profile = runnerIsolationProfileV1Schema.parse(input.profile)
  const command = runnerExecutionCommandV1Schema.parse(input.command)
  const decision = evaluateRunnerCommand({ workspace, profile, command })
  if (!decision.allowed) {
    throw new PlatformError({
      code: 'VALIDATION_FAILED',
      correlationId: command.context.correlationId,
      retryable: false,
      safeMessage: `The sandbox command was rejected by deterministic runner policy: ${decision.rejectionCode}.`,
    })
  }

  return runnerBrokerExecuteRequestV1Schema.parse({
    schemaVersion: '1',
    action: 'execute',
    requestId: command.id,
    commandId: command.id,
    tool: command.tool,
    executable: command.executable,
    arguments: command.arguments,
    workingDirectory: command.workingDirectory,
    timeoutMs: command.timeoutMs,
    limits: {
      maxProcesses: profile.resources.maxProcesses,
      maxFiles: profile.resources.maxFiles,
      maxBytes: profile.resources.maxBytes,
    },
    artifacts: {
      expectedPaths: command.expectedArtifacts.map(({ path }) => path),
      maxCount: profile.artifacts.maxCount,
      maxBytes: profile.artifacts.maxBytes,
    },
    installScripts: profile.dependencies.installScripts,
  })
}

async function safeStop(handle: VercelSandboxHandle): Promise<void> {
  try {
    await handle.stop()
  } catch {
    // Preserve the transport or evidence failure; stop is best-effort.
  }
}

function dependencyError(
  correlationId: CorrelationId,
  safeMessage: string,
  cause: unknown,
): PlatformError {
  return new PlatformError({
    code: 'DEPENDENCY_UNAVAILABLE',
    correlationId,
    retryable: true,
    safeMessage,
    cause,
  })
}
