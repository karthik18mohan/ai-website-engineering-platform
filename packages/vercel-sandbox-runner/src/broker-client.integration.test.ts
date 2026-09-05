import { createHash } from 'node:crypto'

import type {
  RunnerExecutionCommandV1,
  RunnerIsolationProfileV1,
  RunnerWorkspaceV1,
} from '@platform/contracts'
import { PlatformError, runnerProfileDigest } from '@platform/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  planVercelBrokerExecution,
  VercelSandboxBrokerClient,
  type VercelCheckoutBundleV1,
} from './broker-client.js'
import type {
  VercelSandboxCommandResult,
  VercelSandboxHandle,
  VercelSandboxRunCommandRequest,
} from './sdk-client.js'

const id = (value: string) => `00000000-0000-4000-8000-${value.padStart(12, '0')}`
const correlationId = id('99')
const baseCommit = 'b'.repeat(40)
const bundleContent = new TextEncoder().encode('fixture git bundle bytes')

function checkoutBundle(overrides: Partial<VercelCheckoutBundleV1> = {}): VercelCheckoutBundleV1 {
  return {
    schemaVersion: '1',
    requestId: id('1'),
    bundleDigest: createHash('sha256').update(bundleContent).digest('hex'),
    baseCommit,
    issuedAt: '2026-08-16T09:00:00.000Z',
    expiresAt: '2026-08-16T09:05:00.000Z',
    content: bundleContent,
    ...overrides,
  }
}

function commandResult(stdout: unknown, overrides: Partial<VercelSandboxCommandResult> = {}) {
  return {
    exitCode: 0,
    stdout: vi.fn(() => Promise.resolve(JSON.stringify(stdout))),
    stderr: vi.fn(() => Promise.resolve('')),
    ...overrides,
  } satisfies VercelSandboxCommandResult
}

function handle(result: VercelSandboxCommandResult) {
  const writeFiles = vi.fn<VercelSandboxHandle['writeFiles']>()
  writeFiles.mockResolvedValue(undefined)
  const runCommand = vi.fn<VercelSandboxHandle['runCommand']>()
  runCommand.mockResolvedValue(result)
  const stop = vi.fn<VercelSandboxHandle['stop']>()
  stop.mockResolvedValue(undefined)
  return {
    name: 'awp-fixture',
    image: `team/runner@sha256:${'a'.repeat(64)}`,
    vcpus: 2,
    memory: 4096,
    timeout: 600_000,
    persistent: false,
    status: 'running',
    expiresAt: new Date('2026-08-16T10:00:00.000Z'),
    networkPolicy: 'deny-all',
    tags: {},
    writeFiles,
    runCommand,
    readFileToBuffer: vi.fn(() => Promise.resolve(null)),
    stop,
  } satisfies VercelSandboxHandle
}

const profile: RunnerIsolationProfileV1 = {
  schemaVersion: '1',
  id: id('10'),
  version: 'vercel-node22-v1',
  backendClass: 'production_isolation',
  image: { reference: `team/runner@sha256:${'a'.repeat(64)}`, digest: 'a'.repeat(64) },
  resources: {
    cpuMillicores: 2000,
    memoryMiB: 4096,
    timeoutMs: 600_000,
    maxProcesses: 256,
    maxFiles: 100_000,
    maxBytes: 4_294_967_296,
  },
  filesystem: { denyHostFilesystem: true, writableRoots: ['.'] },
  processes: { shell: false, allowedCommands: [{ tool: 'npm-test', executable: 'npm' }] },
  network: { mode: 'denied' },
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

const workspace: RunnerWorkspaceV1 = {
  schemaVersion: '1',
  id: id('11'),
  organizationId: id('12'),
  projectId: id('13'),
  runId: id('14'),
  executionPlanId: id('15'),
  baseCommit,
  profileDigest: runnerProfileDigest(profile),
  backendClass: 'production_isolation',
  checkoutEvidence: {
    source: 'isolated_runtime',
    commit: baseCommit,
    treeDigest: 'c'.repeat(64),
    detached: true,
    clean: true,
  },
  state: 'ready',
  createdAt: '2026-08-16T09:00:00.000Z',
  expiresAt: '2026-08-16T09:10:00.000Z',
}

const executionCommand: RunnerExecutionCommandV1 = {
  schemaVersion: '1',
  context: {
    schemaVersion: '1',
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
    actorRef: `service:${id('16')}`,
    correlationId,
    idempotencyKey: 'execute-1',
    requestedAt: '2026-08-16T09:01:00.000Z',
  },
  id: id('17'),
  workspaceId: workspace.id,
  runId: workspace.runId,
  baseCommit,
  profileDigest: workspace.profileDigest,
  tool: 'npm-test',
  executable: 'npm',
  arguments: ['test', '--', '--runInBand'],
  workingDirectory: '.',
  timeoutMs: 60_000,
  expectedArtifacts: [],
}

describe('Vercel Sandbox broker transport', () => {
  it('stages a fresh digest-bound bundle and invokes only the fixed broker as root', async () => {
    const bundle = checkoutBundle()
    const result = {
      schemaVersion: '1',
      requestId: bundle.requestId,
      action: 'checkout',
      status: 'succeeded',
      commit: baseCommit,
      treeDigest: 'c'.repeat(64),
      detached: true,
      clean: true,
    } as const
    const sandbox = handle(commandResult(result))
    const client = new VercelSandboxBrokerClient({
      clock: () => new Date('2026-08-16T09:01:00.000Z'),
    })

    await expect(client.checkout(sandbox, bundle, correlationId)).resolves.toEqual(result)
    expect(sandbox.writeFiles).toHaveBeenCalledOnce()
    const stagedFiles = sandbox.writeFiles.mock.calls[0]?.[0]
    expect(stagedFiles?.[0]).toEqual({
      path: `/home/runner/.platform-control/${bundle.requestId}.bundle`,
      content: bundleContent,
      mode: 0o600,
    })
    expect(stagedFiles?.[1]?.path).toBe(`/home/runner/.platform-control/${bundle.requestId}.json`)
    expect(stagedFiles?.[1]?.mode).toBe(0o600)
    expect(typeof stagedFiles?.[1]?.content).toBe('string')
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: '/opt/ai-website-platform/bin/runner-exec',
      args: [`/home/runner/.platform-control/${bundle.requestId}.json`],
      env: {},
      sudo: true,
      timeoutMs: 240_000,
    } satisfies VercelSandboxRunCommandRequest)
    expect(sandbox.stop).not.toHaveBeenCalled()
  })

  it.each([
    ['expired', { expiresAt: '2026-08-16T09:01:00.000Z' }],
    ['digest mismatch', { bundleDigest: '0'.repeat(64) }],
    ['excessive lifetime', { expiresAt: '2026-08-16T09:06:00.001Z' }],
  ])('rejects a %s checkout bundle before provider mutation', async (_label, override) => {
    const sandbox = handle(commandResult({}))
    const client = new VercelSandboxBrokerClient({
      clock: () => new Date('2026-08-16T09:01:00.000Z'),
    })

    await expect(
      client.checkout(sandbox, checkoutBundle(override), correlationId),
    ).rejects.toBeInstanceOf(PlatformError)
    expect(sandbox.writeFiles).not.toHaveBeenCalled()
    expect(sandbox.runCommand).not.toHaveBeenCalled()
  })

  it('stops the sandbox when broker evidence is malformed', async () => {
    const sandbox = handle(commandResult({ action: 'checkout', status: 'succeeded' }))
    const client = new VercelSandboxBrokerClient({
      clock: () => new Date('2026-08-16T09:01:00.000Z'),
    })

    await expect(client.checkout(sandbox, checkoutBundle(), correlationId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: false,
    })
    expect(sandbox.stop).toHaveBeenCalledOnce()
  })

  it('stops the sandbox and returns a retryable dependency error when staging fails', async () => {
    const sandbox = handle(commandResult({}))
    sandbox.writeFiles.mockRejectedValue(new Error('fixture provider outage'))
    const client = new VercelSandboxBrokerClient({
      clock: () => new Date('2026-08-16T09:01:00.000Z'),
    })

    await expect(client.checkout(sandbox, checkoutBundle(), correlationId)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      retryable: true,
    })
    expect(sandbox.runCommand).not.toHaveBeenCalled()
    expect(sandbox.stop).toHaveBeenCalledOnce()
  })

  it('maps an authorized command without exposing tool argv on the provider command line', async () => {
    const request = planVercelBrokerExecution({ workspace, profile, command: executionCommand })
    const result = {
      schemaVersion: '1',
      requestId: request.requestId,
      action: 'execute',
      status: 'succeeded',
      exitCode: 0,
      durationMs: 250,
      stdoutDigest: 'd'.repeat(64),
      stderrDigest: 'e'.repeat(64),
      stdoutBytes: 12,
      stderrBytes: 0,
      artifacts: [],
    } as const
    const sandbox = handle(commandResult(result))
    const client = new VercelSandboxBrokerClient()

    await expect(
      client.execute(sandbox, { workspace, profile, command: executionCommand }),
    ).resolves.toEqual(result)
    const providerRequest = sandbox.runCommand.mock.calls[0]?.[0]
    expect(providerRequest?.args).toEqual([
      `/home/runner/.platform-control/${executionCommand.id}.json`,
    ])
    expect(JSON.stringify(providerRequest)).not.toContain('--runInBand')
    const controlContent = sandbox.writeFiles.mock.calls[0]?.[0][0]?.content
    expect(controlContent).toEqual(expect.stringContaining('--runInBand'))
    expect(request.artifacts).toEqual({ expectedPaths: [], maxCount: 20, maxBytes: 10_000_000 })
  })

  it('rechecks deterministic command policy before staging an envelope', () => {
    expect(() =>
      planVercelBrokerExecution({
        workspace,
        profile,
        command: { ...executionCommand, executable: 'node' },
      }),
    ).toThrow('COMMAND_NOT_ALLOWED')
  })
})
