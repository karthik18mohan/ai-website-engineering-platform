import { createHash } from 'node:crypto'
import type {
  AiInvocationRequestV1,
  AiInvocationResultV1,
  ArtifactReferenceV1,
  DeploymentRequestV1,
  DeploymentResultV1,
  GitRepositoryRefV1,
  ProviderRequestContextV1,
  RunnerCancellationRequestV1,
  RunnerCleanupRequestV1,
  RunnerExecutionCommandV1,
  RunnerExecutionResultV1,
  RunnerIsolationProfileV1,
  RunnerLifecycleResultV1,
  RunnerWorkspaceRequestV1,
  RunnerWorkspaceV1,
  SecretReferenceV1,
} from '@platform/contracts'
import {
  PlatformError,
  evaluateRunnerCommand,
  runnerProfileDigest,
  type AttachmentScannerPort,
  type AiCostControllerPort,
  type ArtifactStorePort,
  type DeploymentProviderPort,
  type GitProviderPort,
  type OrchestrationProviderPort,
  type RunnerProviderPort,
  type SecretsPort,
} from '@platform/domain'

export class MockAttachmentScanner implements AttachmentScannerPort {
  readonly #rejectedDigests: ReadonlySet<string>

  constructor(rejectedDigests: readonly string[] = []) {
    this.#rejectedDigests = new Set(rejectedDigests)
  }

  scan(attachment: Parameters<AttachmentScannerPort['scan']>[0]): Promise<'clean' | 'rejected'> {
    return Promise.resolve(this.#rejectedDigests.has(attachment.digest) ? 'rejected' : 'clean')
  }
}

export class MockSecretsAdapter implements SecretsPort {
  readonly #references = new Set<string>()
  register(reference: SecretReferenceV1): void {
    this.#references.add(this.key(reference))
  }
  exists(_context: ProviderRequestContextV1, reference: SecretReferenceV1): Promise<boolean> {
    return Promise.resolve(this.#references.has(this.key(reference)))
  }
  private key(reference: SecretReferenceV1) {
    return `${reference.provider}:${reference.key}:${reference.version ?? ''}`
  }
}

export class MockGitAdapter implements GitProviderPort {
  constructor(private readonly accessible = true) {}
  verifyRepository(_context: ProviderRequestContextV1, repository: GitRepositoryRefV1) {
    return Promise.resolve({ accessible: this.accessible, defaultBranch: repository.defaultBranch })
  }
}

export class MockDeploymentAdapter implements DeploymentProviderPort {
  constructor(private readonly available = true) {}

  requestPreview(request: DeploymentRequestV1): Promise<DeploymentResultV1> {
    if (!this.available) {
      return Promise.reject(
        new PlatformError({
          code: 'DEPENDENCY_UNAVAILABLE',
          correlationId: request.context.correlationId,
          retryable: true,
          safeMessage: 'The deployment provider is unavailable.',
        }),
      )
    }
    return Promise.resolve({
      schemaVersion: '1',
      providerDeploymentId: `mock-${request.commit.slice(0, 12)}`,
      status: 'ready',
      url: `https://preview.invalid/${request.commit}`,
    })
  }
}

export class MockArtifactStore implements ArtifactStorePort {
  readonly #artifacts = new Map<string, Uint8Array>()
  put(
    _context: ProviderRequestContextV1,
    content: Uint8Array,
    metadata: { readonly mediaType: string; readonly retentionClass: string },
  ): Promise<ArtifactReferenceV1> {
    const digest = createHash('sha256').update(content).digest('hex')
    this.#artifacts.set(digest, content.slice())
    return Promise.resolve({
      schemaVersion: '1',
      uri: `mock-artifact://${digest}`,
      digest,
      mediaType: metadata.mediaType,
      retentionClass: metadata.retentionClass,
    })
  }
}

/**
 * Contract fixture only. It never checks out a repository, starts a process, or
 * provides a security boundary. Production isolation requires a separate adapter.
 */
export class ConformanceRunnerFixture implements RunnerProviderPort {
  readonly #clock: () => Date
  readonly #results = new Map<string, { fingerprint: string; result: RunnerExecutionResultV1 }>()
  readonly #workspaces = new Map<
    string,
    { profile: RunnerIsolationProfileV1; workspace: RunnerWorkspaceV1 }
  >()

  constructor(clock: () => Date = () => new Date()) {
    this.#clock = clock
  }

  provision(request: RunnerWorkspaceRequestV1): Promise<RunnerWorkspaceV1> {
    if (request.profile.backendClass !== 'conformance_fixture') {
      return Promise.reject(
        new PlatformError({
          code: 'CONFIGURATION_INVALID',
          correlationId: request.context.correlationId,
          retryable: false,
          safeMessage: 'The conformance fixture cannot provide production isolation.',
        }),
      )
    }
    const id = deterministicOpaqueId(
      `${request.context.organizationId}:${request.context.projectId}:${request.runId}:${request.context.idempotencyKey}`,
    )
    const existing = this.#workspaces.get(id)
    if (existing !== undefined) return Promise.resolve(existing.workspace)
    const createdAt = this.#clock()
    const workspace: RunnerWorkspaceV1 = {
      schemaVersion: '1',
      id,
      organizationId: request.context.organizationId,
      projectId: request.context.projectId,
      runId: request.runId,
      executionPlanId: request.executionPlanId,
      baseCommit: request.baseCommit,
      profileDigest: runnerProfileDigest(request.profile),
      backendClass: 'conformance_fixture',
      checkoutEvidence: {
        source: 'conformance_fixture',
        commit: request.baseCommit,
        treeDigest: createHash('sha256')
          .update(
            `${request.repository.provider}:${request.repository.repositoryId}:${request.baseCommit}`,
          )
          .digest('hex'),
        detached: true,
        clean: true,
      },
      state: 'ready',
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + request.profile.resources.timeoutMs).toISOString(),
    }
    this.#workspaces.set(id, { profile: request.profile, workspace })
    return Promise.resolve(workspace)
  }

  execute(command: RunnerExecutionCommandV1): Promise<RunnerExecutionResultV1> {
    const resultKey = `${command.context.organizationId}:${command.context.projectId}:${command.workspaceId}:${command.id}`
    const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex')
    const existing = this.#results.get(resultKey)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new PlatformError({
            code: 'CONFLICT',
            correlationId: command.context.correlationId,
            retryable: false,
            safeMessage: 'The command identifier belongs to a different runner request.',
          }),
        )
      }
      return Promise.resolve(existing.result)
    }
    const entry = this.#workspaces.get(command.workspaceId)
    const now = this.#clock().toISOString()
    const decision =
      entry === undefined
        ? ({ allowed: false, rejectionCode: 'WORKSPACE_NOT_READY' } as const)
        : this.#clock().getTime() > new Date(entry.workspace.expiresAt).getTime()
          ? ({ allowed: false, rejectionCode: 'TIME_LIMIT_EXCEEDED' } as const)
          : evaluateRunnerCommand({ command, ...entry })
    const result: RunnerExecutionResultV1 = decision.allowed
      ? {
          schemaVersion: '1',
          commandId: command.id,
          workspaceId: command.workspaceId,
          runId: command.runId,
          baseCommit: command.baseCommit,
          profileDigest: command.profileDigest,
          executionKind: 'simulated_conformance',
          status: 'succeeded',
          exitCode: 0,
          artifacts: [],
          startedAt: now,
          completedAt: now,
        }
      : {
          schemaVersion: '1',
          commandId: command.id,
          workspaceId: command.workspaceId,
          runId: command.runId,
          baseCommit: command.baseCommit,
          profileDigest: command.profileDigest,
          executionKind: 'simulated_conformance',
          status: 'rejected',
          rejectionCode: decision.rejectionCode,
          artifacts: [],
          startedAt: now,
          completedAt: now,
        }
    this.#results.set(resultKey, { fingerprint, result })
    return Promise.resolve(result)
  }

  async cancel(request: RunnerCancellationRequestV1): Promise<RunnerLifecycleResultV1> {
    const entry = this.#requireScopedWorkspace(request)
    if (entry.workspace.state === 'destroyed') {
      throw this.#lifecycleError(
        request.context.correlationId,
        'Destroyed workspace cannot cancel.',
      )
    }
    const alreadyCancelled = entry.workspace.state === 'cancelled'
    if (!alreadyCancelled) entry.workspace = { ...entry.workspace, state: 'cancelled' }
    return Promise.resolve({
      schemaVersion: '1',
      workspaceId: entry.workspace.id,
      runId: entry.workspace.runId,
      status: alreadyCancelled ? 'already_cancelled' : 'cancelled',
      occurredAt: this.#clock().toISOString(),
    })
  }

  async destroy(request: RunnerCleanupRequestV1): Promise<RunnerLifecycleResultV1> {
    const entry = this.#requireScopedWorkspace(request)
    const alreadyDestroyed = entry.workspace.state === 'destroyed'
    if (!alreadyDestroyed) entry.workspace = { ...entry.workspace, state: 'destroyed' }
    return Promise.resolve({
      schemaVersion: '1',
      workspaceId: entry.workspace.id,
      runId: entry.workspace.runId,
      status: alreadyDestroyed ? 'already_destroyed' : 'destroyed',
      occurredAt: this.#clock().toISOString(),
    })
  }

  #requireScopedWorkspace(request: RunnerCancellationRequestV1 | RunnerCleanupRequestV1): {
    profile: RunnerIsolationProfileV1
    workspace: RunnerWorkspaceV1
  } {
    const entry = this.#workspaces.get(request.workspaceId)
    if (
      entry === undefined ||
      entry.workspace.organizationId !== request.context.organizationId ||
      entry.workspace.projectId !== request.context.projectId ||
      entry.workspace.runId !== request.runId
    ) {
      throw new PlatformError({
        code: 'AUTHORIZATION_DENIED',
        correlationId: request.context.correlationId,
        retryable: false,
        safeMessage: 'The workspace is unavailable in this tenant and run scope.',
      })
    }
    return entry
  }

  #lifecycleError(correlationId: string, safeMessage: string): PlatformError {
    return new PlatformError({
      code: 'CONFLICT',
      correlationId,
      retryable: false,
      safeMessage,
    })
  }
}

export class MockOrchestrationAdapter implements OrchestrationProviderPort {
  dispatch(context: ProviderRequestContextV1, commandRef: ArtifactReferenceV1) {
    return Promise.resolve({
      dispatchId: `mock-${context.idempotencyKey}-${commandRef.digest.slice(0, 8)}`,
    })
  }
}

/** M03 safety default: no model provider can be reached before controller policy exists. */
export class DenyAllAiCostController implements AiCostControllerPort {
  invoke(request: AiInvocationRequestV1): Promise<AiInvocationResultV1> {
    return Promise.reject(
      new PlatformError({
        code: 'AUTHORIZATION_DENIED',
        correlationId: request.context.correlationId,
        retryable: false,
        safeMessage:
          'AI invocation is disabled until cost, budget, routing, and usage policy is configured.',
      }),
    )
  }
}

export function deterministicOpaqueId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
