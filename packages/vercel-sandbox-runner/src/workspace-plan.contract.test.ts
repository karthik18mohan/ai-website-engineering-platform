import type { RunnerIsolationProfileV1, RunnerWorkspaceRequestV1 } from '@platform/contracts'
import { PlatformError } from '@platform/domain'
import { describe, expect, it } from 'vitest'

import { planVercelSandboxWorkspace, type ApprovedVercelSandboxImageV1 } from './workspace-plan.js'
import { VERCEL_RUNNER_IMAGE_SPEC_V1, vercelRunnerImageSpecDigest } from './image-policy.js'

const id = (value: string) => `00000000-0000-4000-8000-${value.padStart(12, '0')}`
const imageDigest = 'a'.repeat(64)
const profile: RunnerIsolationProfileV1 = {
  schemaVersion: '1',
  id: id('1'),
  version: 'vercel-node22-v1',
  backendClass: 'production_isolation',
  image: {
    reference: `team/project/ai-website-runner@sha256:${imageDigest}`,
    digest: imageDigest,
  },
  resources: {
    cpuMillicores: 2000,
    memoryMiB: 4096,
    timeoutMs: 600_000,
    maxProcesses: 256,
    maxFiles: 100_000,
    maxBytes: 4_294_967_296,
  },
  filesystem: { denyHostFilesystem: true, writableRoots: ['.'] },
  processes: {
    shell: false,
    allowedCommands: [{ tool: 'npm-test', executable: 'npm' }],
  },
  network: { mode: 'allowlist', destinations: [{ host: 'registry.npmjs.org', ports: [443] }] },
  dependencies: {
    approvedRegistries: ['https://registry.npmjs.org'],
    installScripts: 'denied',
    allowedInstallScripts: [],
  },
  secrets: { allowProductionSecrets: false, allowedReferenceKeys: [] },
  artifacts: {
    maxCount: 20,
    maxBytes: 10_000_000,
    allowedMediaTypes: ['text/plain'],
    retentionClasses: ['validation-log'],
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
    idempotencyKey: 'provision-1',
    requestedAt: '2026-08-16T06:30:00.000Z',
  },
  runId: id('6'),
  executionPlanId: id('7'),
  repository: { provider: 'github', repositoryId: '12345' },
  baseCommit: 'b'.repeat(40),
  profile,
}
const approvedImage: ApprovedVercelSandboxImageV1 = {
  schemaVersion: '1',
  profileId: profile.id,
  profileVersion: profile.version,
  sdkVersion: '3.0.0',
  imageReference: profile.image.reference,
  imageDigest,
  controls: {
    hostFilesystemDenied: true,
    productionSecretsAbsent: true,
    sudoRemoved: true,
    commandBrokerPath: '/opt/ai-website-platform/bin/runner-exec',
    imageSpecDigest: vercelRunnerImageSpecDigest(),
    commandPaths: [...VERCEL_RUNNER_IMAGE_SPEC_V1.commandPaths],
    maxProcesses: profile.resources.maxProcesses,
    maxFiles: profile.resources.maxFiles,
    maxBytes: profile.resources.maxBytes,
    installScripts: 'denied',
  },
}

describe('Vercel Sandbox production profile planning', () => {
  it('maps an approved digest-pinned profile to a non-persistent deny-by-default sandbox', () => {
    const plan = planVercelSandboxWorkspace(request, [approvedImage])

    expect(plan).toMatchObject({
      provider: 'vercel_sandbox',
      sdkVersion: '3.0.0',
      create: {
        image: profile.image.reference,
        resources: { vcpus: 2 },
        timeout: 600_000,
        persistent: false,
        ports: [],
        networkPolicy: { allow: ['registry.npmjs.org'] },
      },
      expected: { vcpus: 2, memoryMiB: 4096, persistent: false },
    })
    expect(plan.create.name).toMatch(/^awp-[a-f0-9]{32}$/u)
  })

  it.each([
    ['mutable image tag', { imageReference: 'team/project/ai-website-runner:latest' }],
    ['resource mismatch', { controls: { ...approvedImage.controls, maxProcesses: 255 } }],
    [
      'image specification mismatch',
      { controls: { ...approvedImage.controls, imageSpecDigest: '0'.repeat(64) } },
    ],
    [
      'command path mismatch',
      {
        controls: {
          ...approvedImage.controls,
          commandPaths: [{ executable: 'npm', path: '/tmp/npm' }],
        },
      },
    ],
  ])('rejects %s', (_label, override) => {
    const candidate = { ...approvedImage, ...override } as ApprovedVercelSandboxImageV1
    expect(() => planVercelSandboxWorkspace(request, [candidate])).toThrow(PlatformError)
  })

  it('rejects unsupported resource coupling and non-HTTPS allowlist ports', () => {
    expect(() =>
      planVercelSandboxWorkspace(
        {
          ...request,
          profile: { ...profile, resources: { ...profile.resources, memoryMiB: 8192 } },
        },
        [approvedImage],
      ),
    ).toThrow('Vercel Sandbox provides exactly 2048 MiB per vCPU.')

    expect(() =>
      planVercelSandboxWorkspace(
        {
          ...request,
          profile: {
            ...profile,
            network: { mode: 'allowlist', destinations: [{ host: 'example.com', ports: [80] }] },
          },
        },
        [approvedImage],
      ),
    ).toThrow('supports HTTPS destination port 443 only')
  })

  it('maps a network-denied profile to the provider deny-all mode', () => {
    const deniedProfile = { ...profile, network: { mode: 'denied' } } as const
    const deniedRequest = { ...request, profile: deniedProfile }
    expect(planVercelSandboxWorkspace(deniedRequest, [approvedImage]).create.networkPolicy).toBe(
      'deny-all',
    )
  })
})
