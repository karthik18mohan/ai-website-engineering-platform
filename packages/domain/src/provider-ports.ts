import type {
  AiInvocationRequestV1,
  AiInvocationResultV1,
  ArtifactReferenceV1,
  DeploymentRequestV1,
  DeploymentResultV1,
  GitRepositoryRefV1,
  GithubRepositoryMetadataV1,
  ProviderRequestContextV1,
  RunnerCancellationRequestV1,
  RunnerCleanupRequestV1,
  RunnerCheckoutBundleV1,
  RunnerExecutionCommandV1,
  RunnerExecutionResultV1,
  RunnerLifecycleResultV1,
  RunnerWorkspaceRequestV1,
  RunnerWorkspaceV1,
  SecretReferenceV1,
} from '@platform/contracts'

export interface SecretsPort {
  exists(context: ProviderRequestContextV1, reference: SecretReferenceV1): Promise<boolean>
}

export interface GitProviderPort {
  verifyRepository(
    context: ProviderRequestContextV1,
    repository: GitRepositoryRefV1,
  ): Promise<{ readonly accessible: boolean; readonly defaultBranch: string }>
}

export interface GithubAppOnboardingPort {
  initiateInstallation(
    context: ProviderRequestContextV1,
    request: { readonly returnUrl: string; readonly state: string },
  ): Promise<{ readonly authorizationUrl: string }>
  verifyRepository(
    context: ProviderRequestContextV1,
    selection: { readonly installationId: string; readonly repositoryId: string },
  ): Promise<{ readonly accessible: boolean; readonly metadata?: GithubRepositoryMetadataV1 }>
}

export interface DeploymentProviderPort {
  requestPreview(request: DeploymentRequestV1): Promise<DeploymentResultV1>
}

export interface ArtifactStorePort {
  put(
    context: ProviderRequestContextV1,
    content: Uint8Array,
    metadata: {
      readonly artifactId?: string
      readonly mediaType: string
      readonly retentionClass: string
      readonly runId?: string
    },
  ): Promise<ArtifactReferenceV1>
}

/** Tenant-scoped access to protected artifact bytes. */
export interface ArtifactReaderPort {
  read(context: ProviderRequestContextV1, reference: ArtifactReferenceV1): Promise<Uint8Array>
}

export interface RunnerProviderPort {
  provision(request: RunnerWorkspaceRequestV1): Promise<RunnerWorkspaceV1>
  execute(command: RunnerExecutionCommandV1): Promise<RunnerExecutionResultV1>
  cancel(request: RunnerCancellationRequestV1): Promise<RunnerLifecycleResultV1>
  destroy(request: RunnerCleanupRequestV1): Promise<RunnerLifecycleResultV1>
}

/** Credential-free immutable checkout acquisition for runner adapters. */
export interface RunnerCheckoutBundleSourcePort {
  createBundle(request: RunnerWorkspaceRequestV1): Promise<RunnerCheckoutBundleV1>
}

export interface OrchestrationProviderPort {
  dispatch(
    context: ProviderRequestContextV1,
    commandRef: ArtifactReferenceV1,
  ): Promise<{ readonly dispatchId: string }>
}

/** The only model-capable port exposed to application and agent code. */
export interface AiCostControllerPort {
  invoke(request: AiInvocationRequestV1): Promise<AiInvocationResultV1>
}
