import type { PlatformError } from '@platform/domain'
import { describe, expect, it, vi } from 'vitest'

import type {
  VercelSandboxCreateRequest,
  VercelSandboxFactory,
  VercelSandboxHandle,
} from './sdk-client.js'
import { createVerifiedVercelSandboxSession } from './verified-session.js'
import type { VercelSandboxWorkspacePlan } from './workspace-plan.js'

const create = {
  name: 'awp-0123456789abcdef0123456789abcdef',
  image: 'team/runner@sha256:' + 'a'.repeat(64),
  resources: { vcpus: 2 },
  timeout: 600_000,
  networkPolicy: { allow: ['registry.npmjs.org'] },
  persistent: false,
  ports: [],
  tags: {},
} satisfies VercelSandboxCreateRequest

const plan: VercelSandboxWorkspacePlan = {
  provider: 'vercel_sandbox',
  correlationId: '00000000-0000-4000-8000-000000000001',
  sdkVersion: '3.0.0',
  profileDigest: 'b'.repeat(64),
  create,
  expected: {
    image: create.image,
    vcpus: 2,
    memoryMiB: 4096,
    persistent: false,
    networkPolicy: create.networkPolicy,
  },
}

function handle(overrides: Partial<VercelSandboxHandle> = {}) {
  return {
    name: create.name,
    image: create.image,
    vcpus: 2,
    memory: 4096,
    timeout: create.timeout,
    persistent: false,
    status: 'running',
    expiresAt: new Date('2026-08-16T07:00:00.000Z'),
    networkPolicy: create.networkPolicy,
    tags: create.tags,
    writeFiles: vi.fn(() => Promise.resolve()),
    runCommand: vi.fn(() => Promise.reject(new Error('Not used by session verification.'))),
    readFileToBuffer: vi.fn(() => Promise.resolve(null)),
    stop: vi.fn(() => Promise.resolve(undefined)),
    ...overrides,
  } satisfies VercelSandboxHandle
}

describe('verified Vercel Sandbox session creation', () => {
  it('returns a provider session only after its immutable controls match the plan', async () => {
    const sandbox = handle()
    const factory: VercelSandboxFactory = {
      create: vi.fn(() => Promise.resolve(sandbox)),
      get: vi.fn(() => Promise.resolve(sandbox)),
    }

    await expect(createVerifiedVercelSandboxSession(plan, factory)).resolves.toBe(sandbox)
    expect(sandbox.stop).not.toHaveBeenCalled()
  })

  it('stops and rejects a session whose provider evidence differs from the plan', async () => {
    const sandbox = handle({ image: 'team/runner:mutable' })
    const factory: VercelSandboxFactory = {
      create: vi.fn(() => Promise.resolve(sandbox)),
      get: vi.fn(() => Promise.resolve(sandbox)),
    }

    await expect(createVerifiedVercelSandboxSession(plan, factory)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: false,
      correlationId: plan.correlationId,
    } satisfies Partial<PlatformError>)
    expect(sandbox.stop).toHaveBeenCalledOnce()
  })
})
