import { describe, expect, it } from 'vitest'

import {
  runnerExecutionCommandV1Schema,
  runnerExecutionResultV1Schema,
  runnerIsolationProfileV1Schema,
  runnerWorkspaceRequestV1Schema,
} from './runner-v1.js'

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`

function profile() {
  return {
    schemaVersion: '1' as const,
    id: id('1'),
    version: 'fixture-v1',
    backendClass: 'conformance_fixture' as const,
    image: { reference: 'fixture.invalid/runner', digest: 'a'.repeat(64) },
    resources: {
      cpuMillicores: 500,
      memoryMiB: 512,
      timeoutMs: 60_000,
      maxProcesses: 20,
      maxFiles: 10_000,
      maxBytes: 100_000_000,
    },
    filesystem: { denyHostFilesystem: true as const, writableRoots: ['workspace'] },
    processes: {
      shell: false as const,
      allowedCommands: [{ tool: 'test', executable: 'npm' }],
    },
    network: { mode: 'denied' as const },
    dependencies: {
      approvedRegistries: ['https://registry.npmjs.org'],
      installScripts: 'denied' as const,
      allowedInstallScripts: [],
    },
    secrets: { allowProductionSecrets: false as const, allowedReferenceKeys: [] },
    artifacts: {
      maxCount: 10,
      maxBytes: 1_000_000,
      allowedMediaTypes: ['application/json'],
      retentionClasses: ['test'],
    },
  }
}

const context = {
  schemaVersion: '1' as const,
  organizationId: id('2'),
  projectId: id('3'),
  actorRef: `service:${id('4')}`,
  correlationId: id('5'),
  idempotencyKey: 'runner-contract-fixture',
  requestedAt: '2026-08-11T12:00:00.000Z',
}

describe('M08 runner contracts', () => {
  it('accepts a deny-by-default profile and immutable workspace request', () => {
    expect(
      runnerWorkspaceRequestV1Schema.safeParse({
        schemaVersion: '1',
        context,
        runId: id('6'),
        executionPlanId: id('7'),
        repository: { provider: 'fixture', repositoryId: 'repo-1' },
        baseCommit: 'b'.repeat(40),
        profile: profile(),
      }).success,
    ).toBe(true)
  })

  it('rejects shell execution, host-relative traversal, and inconsistent install policy', () => {
    expect(
      runnerIsolationProfileV1Schema.safeParse({
        ...profile(),
        processes: { ...profile().processes, shell: true },
      }).success,
    ).toBe(false)
    expect(
      runnerIsolationProfileV1Schema.safeParse({
        ...profile(),
        dependencies: {
          ...profile().dependencies,
          allowedInstallScripts: ['postinstall'],
        },
      }).success,
    ).toBe(false)
    expect(
      runnerExecutionCommandV1Schema.safeParse({
        schemaVersion: '1',
        context,
        id: id('8'),
        workspaceId: id('9'),
        runId: id('6'),
        baseCommit: 'b'.repeat(40),
        profileDigest: 'c'.repeat(64),
        tool: 'test',
        executable: 'npm',
        arguments: ['test'],
        workingDirectory: '../host',
        timeoutMs: 1000,
        expectedArtifacts: [],
      }).success,
    ).toBe(false)
    expect(
      runnerExecutionCommandV1Schema.safeParse({
        schemaVersion: '1',
        context,
        id: id('8'),
        workspaceId: id('9'),
        runId: id('6'),
        baseCommit: 'b'.repeat(40),
        profileDigest: 'c'.repeat(64),
        tool: 'test',
        executable: 'npm',
        arguments: ['test'],
        workingDirectory: 'C:/host',
        timeoutMs: 1000,
        expectedArtifacts: [],
      }).success,
    ).toBe(false)
    expect(
      runnerExecutionCommandV1Schema.safeParse({
        schemaVersion: '1',
        context,
        id: id('8'),
        workspaceId: id('9'),
        runId: id('6'),
        baseCommit: 'b'.repeat(40),
        profileDigest: 'c'.repeat(64),
        tool: 'test',
        executable: 'npm',
        arguments: ['test'],
        workingDirectory: '.',
        timeoutMs: 1000,
        expectedArtifacts: [{ path: '.', mediaType: 'application/json', retentionClass: 'test' }],
      }).success,
    ).toBe(false)
  })

  it('requires coherent rejection and exit evidence', () => {
    const result = {
      schemaVersion: '1',
      commandId: id('8'),
      workspaceId: id('9'),
      runId: id('6'),
      baseCommit: 'b'.repeat(40),
      profileDigest: 'c'.repeat(64),
      executionKind: 'simulated_conformance',
      status: 'rejected',
      rejectionCode: 'COMMAND_NOT_ALLOWED',
      artifacts: [],
      startedAt: '2026-08-11T12:00:00.000Z',
      completedAt: '2026-08-11T12:00:00.000Z',
    }
    expect(runnerExecutionResultV1Schema.safeParse(result).success).toBe(true)
    expect(runnerExecutionResultV1Schema.safeParse({ ...result, exitCode: 1 }).success).toBe(false)
  })
})
