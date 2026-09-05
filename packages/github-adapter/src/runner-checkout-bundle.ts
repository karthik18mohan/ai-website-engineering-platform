import { createHash, randomUUID } from 'node:crypto'

import {
  runnerCheckoutBundleV1Schema,
  runnerWorkspaceRequestV1Schema,
  type ProviderRequestContextV1,
  type RunnerCheckoutBundleV1,
  type RunnerWorkspaceRequestV1,
} from '@platform/contracts'
import { PlatformError, type RunnerCheckoutBundleSourcePort } from '@platform/domain'
import { z } from 'zod'

const MAX_BUNDLE_BYTES = 1_073_741_824
const MAX_ACCESS_LIFETIME_MS = 300_000

const githubBundleResultSchema = z
  .object({
    repositoryId: z.string().trim().min(1).max(256),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    accessExpiresAt: z.iso.datetime({ offset: true }),
    content: z.instanceof(Uint8Array),
  })
  .strict()

export interface GithubShortLivedRepositoryBundleClient {
  /**
   * Acquires and disposes an approved short-lived installation credential
   * internally. Credential material must never appear in the result.
   */
  createBundle(input: {
    readonly context: ProviderRequestContextV1
    readonly repositoryId: string
    readonly baseCommit: string
  }): Promise<z.input<typeof githubBundleResultSchema>>
}

export interface GithubRunnerCheckoutBundleSourceOptions {
  readonly client: GithubShortLivedRepositoryBundleClient
  readonly clock?: () => Date
  readonly idFactory?: () => string
}

export class GithubRunnerCheckoutBundleSource implements RunnerCheckoutBundleSourcePort {
  readonly #client: GithubShortLivedRepositoryBundleClient
  readonly #clock: () => Date
  readonly #idFactory: () => string

  constructor(options: GithubRunnerCheckoutBundleSourceOptions) {
    this.#client = options.client
    this.#clock = options.clock ?? (() => new Date())
    this.#idFactory = options.idFactory ?? randomUUID
  }

  async createBundle(rawRequest: RunnerWorkspaceRequestV1): Promise<RunnerCheckoutBundleV1> {
    const request = runnerWorkspaceRequestV1Schema.parse(rawRequest)
    if (request.repository.provider !== 'github') {
      throw this.#error(request, 'CONFIGURATION_INVALID', 'The checkout source requires GitHub.')
    }

    let rawBundle: unknown
    try {
      rawBundle = await this.#client.createBundle({
        context: request.context,
        repositoryId: request.repository.repositoryId,
        baseCommit: request.baseCommit,
      })
    } catch (cause) {
      if (cause instanceof PlatformError) throw cause
      throw this.#error(
        request,
        'DEPENDENCY_UNAVAILABLE',
        'The immutable repository bundle could not be acquired.',
        true,
        cause,
      )
    }

    let source
    try {
      source = githubBundleResultSchema.parse(rawBundle)
    } catch (cause) {
      throw this.#error(
        request,
        'VALIDATION_FAILED',
        'The repository bundle source returned invalid evidence.',
        false,
        cause,
      )
    }
    const issuedAt = this.#clock()
    const accessExpiresAt = new Date(source.accessExpiresAt)
    if (
      source.repositoryId !== request.repository.repositoryId ||
      source.baseCommit !== request.baseCommit ||
      source.content.byteLength === 0 ||
      source.content.byteLength > MAX_BUNDLE_BYTES ||
      accessExpiresAt.getTime() <= issuedAt.getTime() ||
      accessExpiresAt.getTime() - issuedAt.getTime() > MAX_ACCESS_LIFETIME_MS
    ) {
      throw this.#error(
        request,
        'VALIDATION_FAILED',
        'The repository bundle is stale, oversized, or bound to a different repository revision.',
      )
    }

    return runnerCheckoutBundleV1Schema.parse({
      schemaVersion: '1',
      requestId: this.#idFactory(),
      repository: request.repository,
      baseCommit: request.baseCommit,
      bundleDigest: createHash('sha256').update(source.content).digest('hex'),
      issuedAt: issuedAt.toISOString(),
      expiresAt: accessExpiresAt.toISOString(),
      content: source.content,
    })
  }

  #error(
    request: RunnerWorkspaceRequestV1,
    code: ConstructorParameters<typeof PlatformError>[0]['code'],
    safeMessage: string,
    retryable = false,
    cause?: unknown,
  ): PlatformError {
    return new PlatformError({
      code,
      correlationId: request.context.correlationId,
      retryable,
      safeMessage,
      ...(cause === undefined ? {} : { cause }),
    })
  }
}
