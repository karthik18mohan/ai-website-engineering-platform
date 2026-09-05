import { createHash } from 'node:crypto'

import type { RunnerIsolationProfileV1, RunnerWorkspaceRequestV1 } from '@platform/contracts'
import { describe, expect, it, vi } from 'vitest'

import {
  GithubRunnerCheckoutBundleSource,
  type GithubShortLivedRepositoryBundleClient,
} from './runner-checkout-bundle.js'

const id = (value: string) => `00000000-0000-4000-8000-${value.padStart(12, '0')}`
const now = new Date('2026-08-16T10:00:00.000Z')
const content = new TextEncoder().encode('credential-free git bundle fixture')
const profile: RunnerIsolationProfileV1 = {
  schemaVersion: '1',
  id: id('1'),
  version: 'fixture',
  backendClass: 'production_isolation',
  image: { reference: `team/runner@sha256:${'a'.repeat(64)}`, digest: 'a'.repeat(64) },
  resources: {
    cpuMillicores: 1000,
    memoryMiB: 2048,
    timeoutMs: 600_000,
    maxProcesses: 256,
    maxFiles: 100_000,
    maxBytes: 4_294_967_296,
  },
  filesystem: { denyHostFilesystem: true, writableRoots: ['.'] },
  processes: { shell: false, allowedCommands: [{ tool: 'test', executable: 'npm' }] },
  network: { mode: 'denied' },
  dependencies: {
    approvedRegistries: ['https://registry.npmjs.org'],
    installScripts: 'denied',
    allowedInstallScripts: [],
  },
  secrets: { allowProductionSecrets: false, allowedReferenceKeys: [] },
  artifacts: {
    maxCount: 1,
    maxBytes: 1024,
    allowedMediaTypes: ['text/plain'],
    retentionClasses: ['test'],
  },
}
const request: RunnerWorkspaceRequestV1 = {
  schemaVersion: '1',
  context: {
    schemaVersion: '1',
    organizationId: id('2'),
    projectId: id('3'),
    actorRef: `service:${id('4')}`,
    correlationId: id('5'),
    idempotencyKey: 'bundle-source-1',
    requestedAt: now.toISOString(),
  },
  runId: id('6'),
  executionPlanId: id('7'),
  repository: { provider: 'github', repositoryId: '12345' },
  baseCommit: 'b'.repeat(40),
  profile,
}

function client(overrides: Record<string, unknown> = {}) {
  const createBundle = vi.fn<GithubShortLivedRepositoryBundleClient['createBundle']>()
  createBundle.mockResolvedValue({
    repositoryId: request.repository.repositoryId,
    baseCommit: request.baseCommit,
    accessExpiresAt: '2026-08-16T10:04:00.000Z',
    content,
    ...overrides,
  })
  return { createBundle }
}

describe('GitHub runner checkout bundle source', () => {
  it('returns only a fresh digest-bound bundle after caller-side short-lived access', async () => {
    const github = client()
    const source = new GithubRunnerCheckoutBundleSource({
      client: github,
      clock: () => now,
      idFactory: () => id('8'),
    })

    const bundle = await source.createBundle(request)

    expect(github.createBundle).toHaveBeenCalledWith({
      context: request.context,
      repositoryId: '12345',
      baseCommit: request.baseCommit,
    })
    expect(bundle).toMatchObject({
      requestId: id('8'),
      repository: request.repository,
      baseCommit: request.baseCommit,
      expiresAt: '2026-08-16T10:04:00.000Z',
    })
    expect(bundle.bundleDigest).toBe(createHash('sha256').update(content).digest('hex'))
    expect(Object.keys(bundle)).not.toEqual(
      expect.arrayContaining(['credential', 'token', 'secret']),
    )
  })

  it.each([
    ['different commit', { baseCommit: 'c'.repeat(40) }],
    ['expired access', { accessExpiresAt: now.toISOString() }],
    ['excessive access lifetime', { accessExpiresAt: '2026-08-16T10:05:00.001Z' }],
  ])('rejects %s evidence', async (_label, override) => {
    const source = new GithubRunnerCheckoutBundleSource({
      client: client(override),
      clock: () => now,
    })
    await expect(source.createBundle(request)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: false,
    })
  })

  it('rejects a non-GitHub repository before acquiring access', async () => {
    const github = client()
    const source = new GithubRunnerCheckoutBundleSource({ client: github, clock: () => now })
    await expect(
      source.createBundle({
        ...request,
        repository: { ...request.repository, provider: 'gitlab' },
      }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' })
    expect(github.createBundle).not.toHaveBeenCalled()
  })
})
