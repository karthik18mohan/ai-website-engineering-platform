import {
  runnerExecutionResultV1Schema,
  runnerLifecycleResultV1Schema,
  runnerWorkspaceV1Schema,
  type ProviderRequestContextV1,
  type RunnerExecutionCommandV1,
  type RunnerIsolationProfileV1,
} from '@platform/contracts'
import { runnerProfileDigest } from '@platform/domain'
import { describe, expect, it } from 'vitest'

import { ConformanceRunnerFixture } from './mocks.js'

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
const context: ProviderRequestContextV1 = {
  schemaVersion: '1',
  organizationId: id('1'),
  projectId: id('2'),
  actorRef: `service:${id('3')}`,
  correlationId: id('4'),
  idempotencyKey: 'runner-conformance-fixture',
  requestedAt: '2026-08-11T12:00:00.000Z',
}
const profile: RunnerIsolationProfileV1 = {
  schemaVersion: '1',
  id: id('5'),
  version: 'fixture-v1',
  backendClass: 'conformance_fixture',
  image: { reference: 'fixture.invalid/runner', digest: 'a'.repeat(64) },
  resources: {
    cpuMillicores: 500,
    memoryMiB: 512,
    timeoutMs: 60_000,
    maxProcesses: 20,
    maxFiles: 10_000,
    maxBytes: 100_000_000,
  },
  filesystem: { denyHostFilesystem: true, writableRoots: ['workspace'] },
  processes: { shell: false, allowedCommands: [{ tool: 'test', executable: 'npm' }] },
  network: { mode: 'denied' },
  dependencies: {
    approvedRegistries: ['https://registry.npmjs.org'],
    installScripts: 'denied',
    allowedInstallScripts: [],
  },
  secrets: { allowProductionSecrets: false, allowedReferenceKeys: [] },
  artifacts: {
    maxCount: 10,
    maxBytes: 1_000_000,
    allowedMediaTypes: ['application/json'],
    retentionClasses: ['test'],
  },
}

describe('M08 runner conformance fixture', () => {
  it('binds an idempotent simulated workspace to the immutable commit and profile', async () => {
    const runner = new ConformanceRunnerFixture(() => new Date('2026-08-11T12:00:00.000Z'))
    const request = {
      schemaVersion: '1' as const,
      context,
      runId: id('6'),
      executionPlanId: id('7'),
      repository: { provider: 'fixture', repositoryId: 'repo-1' },
      baseCommit: 'b'.repeat(40),
      profile,
    }
    const first = runnerWorkspaceV1Schema.parse(await runner.provision(request))
    const second = runnerWorkspaceV1Schema.parse(await runner.provision(request))
    expect(second).toEqual(first)
    expect(first).toMatchObject({
      backendClass: 'conformance_fixture',
      baseCommit: request.baseCommit,
      profileDigest: runnerProfileDigest(profile),
      checkoutEvidence: { source: 'conformance_fixture', detached: true, clean: true },
    })

    const command: RunnerExecutionCommandV1 = {
      schemaVersion: '1',
      context,
      id: id('8'),
      workspaceId: first.id,
      runId: first.runId,
      baseCommit: first.baseCommit,
      profileDigest: first.profileDigest,
      tool: 'test',
      executable: 'npm',
      arguments: ['test'],
      workingDirectory: 'workspace',
      timeoutMs: 30_000,
      expectedArtifacts: [],
    }
    const execution = runnerExecutionResultV1Schema.parse(await runner.execute(command))
    expect(execution).toMatchObject({
      executionKind: 'simulated_conformance',
      status: 'succeeded',
      exitCode: 0,
    })
    expect(await runner.execute(command)).toEqual(execution)
    await expect(runner.execute({ ...command, executable: 'powershell' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('rejects commands outside the allowlist and stale immutable bindings', async () => {
    const runner = new ConformanceRunnerFixture(() => new Date('2026-08-11T12:00:00.000Z'))
    const workspace = await runner.provision({
      schemaVersion: '1',
      context,
      runId: id('6'),
      executionPlanId: id('7'),
      repository: { provider: 'fixture', repositoryId: 'repo-1' },
      baseCommit: 'b'.repeat(40),
      profile,
    })
    const command: RunnerExecutionCommandV1 = {
      schemaVersion: '1',
      context,
      id: id('8'),
      workspaceId: workspace.id,
      runId: workspace.runId,
      baseCommit: workspace.baseCommit,
      profileDigest: workspace.profileDigest,
      tool: 'test',
      executable: 'powershell',
      arguments: [],
      workingDirectory: 'workspace',
      timeoutMs: 1000,
      expectedArtifacts: [],
    }
    expect(await runner.execute(command)).toMatchObject({
      status: 'rejected',
      rejectionCode: 'COMMAND_NOT_ALLOWED',
    })
    expect(
      await runner.execute({ ...command, id: id('9'), baseCommit: 'c'.repeat(40) }),
    ).toMatchObject({ status: 'rejected', rejectionCode: 'STALE_BINDING' })
  })

  it('cancels and destroys idempotently without host execution', async () => {
    const runner = new ConformanceRunnerFixture(() => new Date('2026-08-11T12:00:00.000Z'))
    const workspace = await runner.provision({
      schemaVersion: '1',
      context,
      runId: id('6'),
      executionPlanId: id('7'),
      repository: { provider: 'fixture', repositoryId: 'repo-1' },
      baseCommit: 'b'.repeat(40),
      profile,
    })
    const cancel = {
      schemaVersion: '1' as const,
      context,
      workspaceId: workspace.id,
      runId: workspace.runId,
      reason: 'User requested cancellation.',
    }
    expect(runnerLifecycleResultV1Schema.parse(await runner.cancel(cancel)).status).toBe(
      'cancelled',
    )
    expect(runnerLifecycleResultV1Schema.parse(await runner.cancel(cancel)).status).toBe(
      'already_cancelled',
    )
    const cleanup = {
      schemaVersion: '1' as const,
      context,
      workspaceId: workspace.id,
      runId: workspace.runId,
    }
    expect(runnerLifecycleResultV1Schema.parse(await runner.destroy(cleanup)).status).toBe(
      'destroyed',
    )
    expect(runnerLifecycleResultV1Schema.parse(await runner.destroy(cleanup)).status).toBe(
      'already_destroyed',
    )
    await expect(
      runner.cancel({ ...cancel, context: { ...context, projectId: id('99') } }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' })
  })

  it('refuses to claim a production isolation backend', async () => {
    const runner = new ConformanceRunnerFixture()
    await expect(
      runner.provision({
        schemaVersion: '1',
        context,
        runId: id('6'),
        executionPlanId: id('7'),
        repository: { provider: 'fixture', repositoryId: 'repo-1' },
        baseCommit: 'b'.repeat(40),
        profile: { ...profile, backendClass: 'production_isolation' },
      }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_INVALID' })
  })

  it('rejects a new command after the workspace resource deadline', async () => {
    let now = new Date('2026-08-11T12:00:00.000Z')
    const runner = new ConformanceRunnerFixture(() => now)
    const workspace = await runner.provision({
      schemaVersion: '1',
      context,
      runId: id('6'),
      executionPlanId: id('7'),
      repository: { provider: 'fixture', repositoryId: 'repo-1' },
      baseCommit: 'b'.repeat(40),
      profile,
    })
    now = new Date('2026-08-11T12:01:00.001Z')
    expect(
      await runner.execute({
        schemaVersion: '1',
        context,
        id: id('10'),
        workspaceId: workspace.id,
        runId: workspace.runId,
        baseCommit: workspace.baseCommit,
        profileDigest: workspace.profileDigest,
        tool: 'test',
        executable: 'npm',
        arguments: ['test'],
        workingDirectory: 'workspace',
        timeoutMs: 1000,
        expectedArtifacts: [],
      }),
    ).toMatchObject({ status: 'rejected', rejectionCode: 'TIME_LIMIT_EXCEEDED' })
  })
})
