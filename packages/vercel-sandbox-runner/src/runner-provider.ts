import { createHash, randomUUID } from 'node:crypto'

import {
  artifactReferenceV1Schema,
  runnerArtifactEvidenceV1Schema,
  runnerCancellationRequestV1Schema,
  runnerCheckoutBundleV1Schema,
  runnerCleanupRequestV1Schema,
  runnerExecutionCommandV1Schema,
  runnerExecutionResultV1Schema,
  runnerIsolationProfileV1Schema,
  runnerLifecycleResultV1Schema,
  runnerWorkspaceRequestV1Schema,
  runnerWorkspaceV1Schema,
  type RunnerCheckoutBundleV1,
  type RunnerExecutionCommandV1,
  type RunnerExecutionResultV1,
  type RunnerIsolationProfileV1,
  type RunnerWorkspaceRequestV1,
  type RunnerWorkspaceV1,
} from '@platform/contracts'
import {
  evaluateRunnerCommand,
  PlatformError,
  runnerProfileDigest,
  type ArtifactStorePort,
  type RunnerCheckoutBundleSourcePort,
  type RunnerProviderPort,
} from '@platform/domain'

import { VercelSandboxBrokerClient, type VercelBrokerExecutionInput } from './broker-client.js'
import type { RunnerBrokerExecuteResultV1 } from './broker-protocol.js'
import { VERCEL_RUNNER_IMAGE_SPEC_V1 } from './image-policy.js'
import type { VercelSandboxFactory, VercelSandboxHandle } from './sdk-client.js'
import {
  createVerifiedVercelSandboxSession,
  verifyVercelSandboxSession,
} from './verified-session.js'
import {
  planVercelSandboxWorkspace,
  type ApprovedVercelSandboxImageV1,
  type VercelSandboxWorkspacePlan,
} from './workspace-plan.js'

interface StoredCommand {
  readonly fingerprint: string
  readonly result: RunnerExecutionResultV1
}

interface ActiveCommand {
  readonly controller: AbortController
  readonly fingerprint: string
  readonly result: Promise<RunnerExecutionResultV1>
}

export interface VercelRunnerSession {
  readonly provisionKey: string
  readonly requestFingerprint: string
  handle?: VercelSandboxHandle
  readonly plan: VercelSandboxWorkspacePlan
  readonly profile: RunnerIsolationProfileV1
  workspace: RunnerWorkspaceV1
  readonly commands: Map<string, StoredCommand>
  readonly activeCommands: Map<string, ActiveCommand>
}

/**
 * The store owns credential-free recovery metadata and may omit transient SDK
 * handles when records cross a process boundary.
 */
export interface VercelRunnerSessionStore {
  findByProvisionKey(
    organizationId: string,
    projectId: string,
    provisionKey: string,
  ): Promise<VercelRunnerSession | undefined>
  findByWorkspaceId(
    organizationId: string,
    projectId: string,
    workspaceId: string,
  ): Promise<VercelRunnerSession | undefined>
  save(session: VercelRunnerSession): Promise<void>
}

/** Process-local conformance store; it is not durable worker evidence. */
export class MemoryVercelRunnerSessionStore implements VercelRunnerSessionStore {
  readonly #byProvisionKey = new Map<string, VercelRunnerSession>()
  readonly #byWorkspaceId = new Map<string, VercelRunnerSession>()

  findByProvisionKey(
    organizationId: string,
    projectId: string,
    provisionKey: string,
  ): Promise<VercelRunnerSession | undefined> {
    const session = this.#byProvisionKey.get(provisionKey)
    return Promise.resolve(
      session?.workspace.organizationId === organizationId &&
        session.workspace.projectId === projectId
        ? session
        : undefined,
    )
  }

  findByWorkspaceId(
    organizationId: string,
    projectId: string,
    workspaceId: string,
  ): Promise<VercelRunnerSession | undefined> {
    const session = this.#byWorkspaceId.get(workspaceId)
    return Promise.resolve(
      session?.workspace.organizationId === organizationId &&
        session.workspace.projectId === projectId
        ? session
        : undefined,
    )
  }

  save(session: VercelRunnerSession): Promise<void> {
    const byKey = this.#byProvisionKey.get(session.provisionKey)
    const byWorkspace = this.#byWorkspaceId.get(session.workspace.id)
    if (
      (byKey !== undefined && byKey !== session) ||
      (byWorkspace !== undefined && byWorkspace !== session)
    ) {
      return Promise.reject(new Error('Runner session identity is already registered.'))
    }
    this.#byProvisionKey.set(session.provisionKey, session)
    this.#byWorkspaceId.set(session.workspace.id, session)
    return Promise.resolve()
  }
}

export interface VercelSandboxRunnerProviderOptions {
  readonly approvedImages: readonly ApprovedVercelSandboxImageV1[]
  readonly artifactStore?: ArtifactStorePort
  readonly broker?: VercelSandboxBrokerClient
  readonly bundleSource: RunnerCheckoutBundleSourcePort
  readonly clock?: () => Date
  readonly factory: VercelSandboxFactory
  readonly idFactory?: () => string
  readonly sessions: VercelRunnerSessionStore
}

export class VercelSandboxRunnerProvider implements RunnerProviderPort {
  readonly #approvedImages: readonly ApprovedVercelSandboxImageV1[]
  readonly #artifactStore: ArtifactStorePort | undefined
  readonly #broker: VercelSandboxBrokerClient
  readonly #bundleSource: RunnerCheckoutBundleSourcePort
  readonly #clock: () => Date
  readonly #factory: VercelSandboxFactory
  readonly #idFactory: () => string
  readonly #sessions: VercelRunnerSessionStore

  constructor(options: VercelSandboxRunnerProviderOptions) {
    this.#approvedImages = options.approvedImages
    this.#artifactStore = options.artifactStore
    this.#broker =
      options.broker ??
      new VercelSandboxBrokerClient(options.clock === undefined ? {} : { clock: options.clock })
    this.#bundleSource = options.bundleSource
    this.#clock = options.clock ?? (() => new Date())
    this.#factory = options.factory
    this.#idFactory = options.idFactory ?? randomUUID
    this.#sessions = options.sessions
  }

  async provision(rawRequest: RunnerWorkspaceRequestV1): Promise<RunnerWorkspaceV1> {
    const request = runnerWorkspaceRequestV1Schema.parse(rawRequest)
    const provisionKey = digest(
      `${request.context.organizationId}:${request.context.projectId}:${request.runId}:${request.context.idempotencyKey}`,
    )
    const requestFingerprint = digest(JSON.stringify(request))
    const existing = await this.#sessions.findByProvisionKey(
      request.context.organizationId,
      request.context.projectId,
      provisionKey,
    )
    if (existing !== undefined) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw this.#error(
          request.context.correlationId,
          'CONFLICT',
          'The runner provision key belongs to a different request.',
        )
      }
      return existing.workspace
    }

    const plan = planVercelSandboxWorkspace(request, this.#approvedImages)
    let bundle: RunnerCheckoutBundleV1
    try {
      bundle = runnerCheckoutBundleV1Schema.parse(await this.#bundleSource.createBundle(request))
    } catch (cause) {
      if (cause instanceof PlatformError) throw cause
      throw this.#error(
        request.context.correlationId,
        'VALIDATION_FAILED',
        'The checkout bundle source returned invalid evidence.',
        false,
        cause,
      )
    }
    if (
      bundle.repository.provider !== request.repository.provider ||
      bundle.repository.repositoryId !== request.repository.repositoryId ||
      bundle.baseCommit !== request.baseCommit
    ) {
      throw this.#error(
        request.context.correlationId,
        'VALIDATION_FAILED',
        'The checkout bundle is not bound to the authorized repository revision.',
      )
    }

    let handle: VercelSandboxHandle
    try {
      handle = await createVerifiedVercelSandboxSession(plan, this.#factory)
    } catch (cause) {
      if (cause instanceof PlatformError) throw cause
      throw this.#error(
        request.context.correlationId,
        'DEPENDENCY_UNAVAILABLE',
        'The sandbox provider could not create the authorized workspace.',
        true,
        cause,
      )
    }
    try {
      const checkout = await this.#broker.checkout(
        handle,
        {
          schemaVersion: bundle.schemaVersion,
          requestId: bundle.requestId,
          bundleDigest: bundle.bundleDigest,
          baseCommit: bundle.baseCommit,
          issuedAt: bundle.issuedAt,
          expiresAt: bundle.expiresAt,
          content: bundle.content,
        },
        request.context.correlationId,
      )
      if (
        checkout.status !== 'succeeded' ||
        checkout.commit !== request.baseCommit ||
        checkout.treeDigest === undefined ||
        checkout.detached !== true ||
        checkout.clean !== true
      ) {
        throw this.#error(
          request.context.correlationId,
          'VALIDATION_FAILED',
          'The sandbox did not prove the authorized immutable checkout.',
        )
      }
      const now = this.#clock()
      if (handle.expiresAt === undefined || handle.expiresAt.getTime() <= now.getTime()) {
        throw this.#error(
          request.context.correlationId,
          'VALIDATION_FAILED',
          'The sandbox expiry is missing or already elapsed.',
        )
      }
      const workspace = runnerWorkspaceV1Schema.parse({
        schemaVersion: '1',
        id: this.#idFactory(),
        organizationId: request.context.organizationId,
        projectId: request.context.projectId,
        runId: request.runId,
        executionPlanId: request.executionPlanId,
        baseCommit: request.baseCommit,
        profileDigest: plan.profileDigest,
        backendClass: 'production_isolation',
        checkoutEvidence: {
          source: 'isolated_runtime',
          commit: checkout.commit,
          treeDigest: checkout.treeDigest,
          detached: true,
          clean: true,
        },
        state: 'ready',
        createdAt: now.toISOString(),
        expiresAt: handle.expiresAt.toISOString(),
      })
      await this.#sessions.save({
        provisionKey,
        requestFingerprint,
        handle,
        plan,
        profile: request.profile,
        workspace,
        commands: new Map(),
        activeCommands: new Map(),
      })
      return workspace
    } catch (cause) {
      await safeStop(handle)
      throw cause
    }
  }

  async execute(rawCommand: RunnerExecutionCommandV1): Promise<RunnerExecutionResultV1> {
    const command = runnerExecutionCommandV1Schema.parse(rawCommand)
    const session = await this.#requireSession(
      command.workspaceId,
      command.context.organizationId,
      command.context.projectId,
      command.runId,
      command.context.correlationId,
    )
    const fingerprint = digest(JSON.stringify(command))
    const existing = session.commands.get(command.id)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw this.#error(
          command.context.correlationId,
          'CONFLICT',
          'The runner command identifier belongs to a different request.',
        )
      }
      return existing.result
    }
    const active = session.activeCommands.get(command.id)
    if (active !== undefined) {
      if (active.fingerprint !== fingerprint) {
        throw this.#error(
          command.context.correlationId,
          'CONFLICT',
          'The active runner command identifier belongs to a different request.',
        )
      }
      return active.result
    }

    const now = this.#clock()
    const policy =
      now.getTime() > Date.parse(session.workspace.expiresAt)
        ? ({ allowed: false, rejectionCode: 'TIME_LIMIT_EXCEEDED' } as const)
        : evaluateRunnerCommand({ workspace: session.workspace, profile: session.profile, command })
    if (!policy.allowed) {
      const result = rejectedResult(command, policy.rejectionCode, now)
      session.commands.set(command.id, { fingerprint, result })
      await this.#sessions.save(session)
      return result
    }
    if (command.expectedArtifacts.length > 0 && this.#artifactStore === undefined) {
      throw this.#error(
        command.context.correlationId,
        'CONFIGURATION_INVALID',
        'Artifact storage is not composed for this runner provider.',
      )
    }

    const controller = new AbortController()
    const startedAt = this.#clock()
    const handle = await this.#requireHandle(session, command.context.correlationId)
    const recoveredExisting = session.commands.get(command.id)
    if (recoveredExisting !== undefined) {
      if (recoveredExisting.fingerprint !== fingerprint) {
        throw this.#error(
          command.context.correlationId,
          'CONFLICT',
          'The runner command identifier belongs to a different request.',
        )
      }
      return recoveredExisting.result
    }
    const recoveredActive = session.activeCommands.get(command.id)
    if (recoveredActive !== undefined) {
      if (recoveredActive.fingerprint !== fingerprint) {
        throw this.#error(
          command.context.correlationId,
          'CONFLICT',
          'The active runner command identifier belongs to a different request.',
        )
      }
      return recoveredActive.result
    }
    const operation = (async () => {
      try {
        const broker = await this.#broker.execute(
          handle,
          {
            workspace: session.workspace,
            profile: session.profile,
            command,
          } satisfies VercelBrokerExecutionInput,
          controller.signal,
        )
        const completedAt = this.#clock()
        const artifacts =
          broker.status === 'succeeded'
            ? await this.#captureArtifacts(session, handle, command, broker, controller.signal)
            : []
        const result = mapExecutionResult(command, broker, artifacts, startedAt, completedAt)
        session.commands.set(command.id, { fingerprint, result })
        await this.#sessions.save(session)
        return result
      } catch (cause) {
        await safeStop(handle)
        session.workspace = { ...session.workspace, state: 'destroyed' }
        await this.#sessions.save(session).catch(() => undefined)
        if (cause instanceof PlatformError) throw cause
        throw this.#error(
          command.context.correlationId,
          'VALIDATION_FAILED',
          'The sandbox command result could not be mapped to runner evidence.',
          false,
          cause,
        )
      }
    })()
    session.activeCommands.set(command.id, { controller, fingerprint, result: operation })
    try {
      return await operation
    } finally {
      session.activeCommands.delete(command.id)
    }
  }

  async cancel(rawRequest: Parameters<RunnerProviderPort['cancel']>[0]) {
    const request = runnerCancellationRequestV1Schema.parse(rawRequest)
    const session = await this.#requireSession(
      request.workspaceId,
      request.context.organizationId,
      request.context.projectId,
      request.runId,
      request.context.correlationId,
    )
    if (session.workspace.state === 'destroyed') {
      throw this.#error(
        request.context.correlationId,
        'CONFLICT',
        'A destroyed workspace cannot be cancelled.',
      )
    }
    const already = session.workspace.state === 'cancelled'
    if (!already) {
      for (const activeCommand of session.activeCommands.values())
        activeCommand.controller.abort(request.reason)
      const handle = await this.#requireHandle(session, request.context.correlationId)
      await this.#stopRequired(handle, request.context.correlationId)
      session.workspace = { ...session.workspace, state: 'cancelled' }
      await this.#sessions.save(session)
    }
    return runnerLifecycleResultV1Schema.parse({
      schemaVersion: '1',
      workspaceId: request.workspaceId,
      runId: request.runId,
      status: already ? 'already_cancelled' : 'cancelled',
      occurredAt: this.#clock().toISOString(),
    })
  }

  async destroy(rawRequest: Parameters<RunnerProviderPort['destroy']>[0]) {
    const request = runnerCleanupRequestV1Schema.parse(rawRequest)
    const session = await this.#requireSession(
      request.workspaceId,
      request.context.organizationId,
      request.context.projectId,
      request.runId,
      request.context.correlationId,
    )
    const already = session.workspace.state === 'destroyed'
    if (!already) {
      if (session.workspace.state !== 'cancelled') {
        for (const activeCommand of session.activeCommands.values())
          activeCommand.controller.abort('Workspace cleanup requested.')
        const handle = await this.#requireHandle(session, request.context.correlationId)
        await this.#stopRequired(handle, request.context.correlationId)
      }
      session.workspace = { ...session.workspace, state: 'destroyed' }
      await this.#sessions.save(session)
    }
    return runnerLifecycleResultV1Schema.parse({
      schemaVersion: '1',
      workspaceId: request.workspaceId,
      runId: request.runId,
      status: already ? 'already_destroyed' : 'destroyed',
      occurredAt: this.#clock().toISOString(),
    })
  }

  async #requireSession(
    workspaceId: string,
    organizationId: string,
    projectId: string,
    runId: string,
    correlationId: string,
  ) {
    const session = await this.#sessions.findByWorkspaceId(organizationId, projectId, workspaceId)
    if (
      session === undefined ||
      session.workspace.organizationId !== organizationId ||
      session.workspace.projectId !== projectId ||
      session.workspace.runId !== runId
    ) {
      throw this.#error(
        correlationId,
        'AUTHORIZATION_DENIED',
        'The workspace is unavailable in this tenant and run scope.',
      )
    }
    try {
      session.workspace = runnerWorkspaceV1Schema.parse(session.workspace)
      const profile = runnerIsolationProfileV1Schema.parse(session.profile)
      const expectedName = `awp-${session.provisionKey.slice(0, 32)}`
      if (
        runnerProfileDigest(profile) !== session.workspace.profileDigest ||
        session.plan.profileDigest !== session.workspace.profileDigest ||
        session.plan.create.name !== expectedName ||
        session.plan.create.image !== profile.image.reference ||
        session.plan.expected.image !== profile.image.reference ||
        session.plan.create.timeout !== profile.resources.timeoutMs ||
        session.plan.create.resources.vcpus !== profile.resources.cpuMillicores / 1000 ||
        session.plan.expected.memoryMiB !== profile.resources.memoryMiB ||
        session.plan.create.tags['profile'] !== session.workspace.profileDigest.slice(0, 24) ||
        session.plan.create.tags['run'] !== session.workspace.runId.replaceAll('-', '').slice(0, 24)
      ) {
        throw new Error('Stored runner recovery metadata is not canonically bound.')
      }
    } catch (cause) {
      throw this.#error(
        correlationId,
        'VALIDATION_FAILED',
        'Stored runner recovery evidence is invalid.',
        false,
        cause,
      )
    }
    return session
  }

  async #stopRequired(handle: VercelSandboxHandle, correlationId: string): Promise<void> {
    try {
      await handle.stop()
    } catch (cause) {
      throw this.#error(
        correlationId,
        'DEPENDENCY_UNAVAILABLE',
        'The sandbox could not be stopped.',
        true,
        cause,
      )
    }
  }

  async #requireHandle(session: VercelRunnerSession, correlationId: string) {
    if (session.handle !== undefined) return session.handle
    let handle: VercelSandboxHandle
    try {
      handle = await this.#factory.get({ name: session.plan.create.name, resume: true })
    } catch (cause) {
      throw this.#error(
        correlationId,
        'DEPENDENCY_UNAVAILABLE',
        'The sandbox provider could not reconnect to the authorized workspace.',
        true,
        cause,
      )
    }
    try {
      const verified = await verifyVercelSandboxSession(handle, session.plan)
      if (
        verified.expiresAt?.toISOString() !== session.workspace.expiresAt ||
        verified.expiresAt.getTime() <= this.#clock().getTime()
      ) {
        throw new Error('Recovered sandbox expiry does not match the authorized workspace.')
      }
      session.handle = verified
      await this.#sessions.save(session)
      return verified
    } catch (cause) {
      await safeStop(handle)
      session.workspace = { ...session.workspace, state: 'destroyed' }
      await this.#sessions.save(session).catch(() => undefined)
      if (cause instanceof PlatformError) throw cause
      throw this.#error(
        correlationId,
        'VALIDATION_FAILED',
        'The recovered sandbox does not match the authorized workspace.',
        false,
        cause,
      )
    }
  }

  async #captureArtifacts(
    session: VercelRunnerSession,
    handle: VercelSandboxHandle,
    command: RunnerExecutionCommandV1,
    broker: RunnerBrokerExecuteResultV1,
    signal: AbortSignal,
  ) {
    const brokerArtifacts = broker.artifacts ?? []
    if (
      brokerArtifacts.length !== command.expectedArtifacts.length ||
      brokerArtifacts.some(
        (artifact, index) => artifact.path !== command.expectedArtifacts[index]?.path,
      )
    ) {
      throw new Error('Broker artifact evidence does not match the authorized artifact set.')
    }
    if (brokerArtifacts.length === 0) return []
    if (this.#artifactStore === undefined) {
      throw new Error('Artifact storage is unavailable after command authorization.')
    }

    let totalBytes = 0
    const captured: RunnerExecutionResultV1['artifacts'][number][] = []
    for (const [index, brokerArtifact] of brokerArtifacts.entries()) {
      const expected = command.expectedArtifacts[index]
      if (expected === undefined) throw new Error('Expected artifact metadata is missing.')
      const content = await handle.readFileToBuffer(
        { path: `${VERCEL_RUNNER_IMAGE_SPEC_V1.workspaceRoot}/${expected.path}` },
        { signal },
      )
      if (content === null) throw new Error('Expected artifact content is missing.')
      totalBytes += content.byteLength
      const contentDigest = createHash('sha256').update(content).digest('hex')
      if (
        content.byteLength !== brokerArtifact.sizeBytes ||
        contentDigest !== brokerArtifact.digest ||
        totalBytes > session.profile.artifacts.maxBytes
      ) {
        throw new Error('Expected artifact content does not match broker evidence or limits.')
      }
      const reference = artifactReferenceV1Schema.parse(
        await this.#artifactStore.put(command.context, content, {
          artifactId: artifactId(command.id, expected.path),
          mediaType: expected.mediaType,
          retentionClass: expected.retentionClass,
          runId: command.runId,
        }),
      )
      if (
        reference.digest !== contentDigest ||
        reference.mediaType !== expected.mediaType ||
        reference.retentionClass !== expected.retentionClass
      ) {
        throw new Error('Artifact storage returned evidence that does not match captured content.')
      }
      captured.push(
        runnerArtifactEvidenceV1Schema.parse({
          path: expected.path,
          commandId: command.id,
          reference,
          sizeBytes: content.byteLength,
        }),
      )
    }
    return captured
  }

  #error(
    correlationId: string,
    code: ConstructorParameters<typeof PlatformError>[0]['code'],
    safeMessage: string,
    retryable = false,
    cause?: unknown,
  ) {
    return new PlatformError({
      code,
      correlationId,
      retryable,
      safeMessage,
      ...(cause === undefined ? {} : { cause }),
    })
  }
}

function artifactId(commandId: string, path: string) {
  const digest = createHash('sha256').update(`${commandId}:${path}`).digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function mapExecutionResult(
  command: RunnerExecutionCommandV1,
  broker: RunnerBrokerExecuteResultV1,
  artifacts: RunnerExecutionResultV1['artifacts'],
  startedAt: Date,
  completedAt: Date,
): RunnerExecutionResultV1 {
  if (broker.status === 'rejected') {
    const rejectionCode =
      broker.failureCode === 'COMMAND_NOT_ALLOWED'
        ? 'COMMAND_NOT_ALLOWED'
        : broker.failureCode === 'TIME_LIMIT_EXCEEDED'
          ? 'TIME_LIMIT_EXCEEDED'
          : broker.failureCode === 'FILESYSTEM_LIMIT_EXCEEDED'
            ? 'FILESYSTEM_DENIED'
            : broker.failureCode === 'OUTPUT_LIMIT_EXCEEDED'
              ? 'OUTPUT_LIMIT_EXCEEDED'
              : undefined
    if (rejectionCode === undefined)
      throw new Error('Broker rejection cannot be mapped to the public runner contract.')
    return rejectedResult(command, rejectionCode, completedAt, startedAt)
  }
  return runnerExecutionResultV1Schema.parse({
    schemaVersion: '1',
    commandId: command.id,
    workspaceId: command.workspaceId,
    runId: command.runId,
    baseCommit: command.baseCommit,
    profileDigest: command.profileDigest,
    executionKind: 'isolated_runtime',
    status: broker.status,
    exitCode: broker.exitCode,
    artifacts,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
  })
}

function rejectedResult(
  command: RunnerExecutionCommandV1,
  rejectionCode: NonNullable<RunnerExecutionResultV1['rejectionCode']>,
  completedAt: Date,
  startedAt = completedAt,
) {
  return runnerExecutionResultV1Schema.parse({
    schemaVersion: '1',
    commandId: command.id,
    workspaceId: command.workspaceId,
    runId: command.runId,
    baseCommit: command.baseCommit,
    profileDigest: command.profileDigest,
    executionKind: 'isolated_runtime',
    status: 'rejected',
    rejectionCode,
    artifacts: [],
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
  })
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
async function safeStop(handle: VercelSandboxHandle): Promise<void> {
  try {
    await handle.stop()
  } catch {
    /* preserve the primary failure */
  }
}
