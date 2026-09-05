import type {
  RunnerExecutionCommandV1,
  RunnerIsolationProfileV1,
  RunnerWorkspaceV1,
} from '@platform/contracts'
import { describe, expect, it } from 'vitest'

import { evaluateRunnerCommand, runnerProfileDigest } from './runner-policy.js'

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`

const profile: RunnerIsolationProfileV1 = {
  schemaVersion: '1',
  id: id('1'),
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

const workspace: RunnerWorkspaceV1 = {
  schemaVersion: '1',
  id: id('2'),
  organizationId: id('3'),
  projectId: id('4'),
  runId: id('5'),
  executionPlanId: id('6'),
  baseCommit: 'b'.repeat(40),
  profileDigest: runnerProfileDigest(profile),
  backendClass: 'conformance_fixture',
  checkoutEvidence: {
    source: 'conformance_fixture',
    commit: 'b'.repeat(40),
    treeDigest: 'c'.repeat(64),
    detached: true,
    clean: true,
  },
  state: 'ready',
  createdAt: '2026-08-11T12:00:00.000Z',
  expiresAt: '2026-08-11T12:01:00.000Z',
}

const command: RunnerExecutionCommandV1 = {
  schemaVersion: '1',
  context: {
    schemaVersion: '1',
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
    actorRef: `service:${id('7')}`,
    correlationId: id('8'),
    idempotencyKey: 'runner-policy-fixture',
    requestedAt: '2026-08-11T12:00:00.000Z',
  },
  id: id('9'),
  workspaceId: workspace.id,
  runId: workspace.runId,
  baseCommit: workspace.baseCommit,
  profileDigest: workspace.profileDigest,
  tool: 'test',
  executable: 'npm',
  arguments: ['test'],
  workingDirectory: 'workspace',
  timeoutMs: 30_000,
  expectedArtifacts: [],
}

describe('M08 deterministic runner policy', () => {
  it('hashes profile objects canonically while retaining ordered policy arrays', () => {
    const reordered: RunnerIsolationProfileV1 = {
      artifacts: profile.artifacts,
      secrets: profile.secrets,
      dependencies: profile.dependencies,
      network: profile.network,
      processes: profile.processes,
      filesystem: profile.filesystem,
      resources: profile.resources,
      image: profile.image,
      backendClass: profile.backendClass,
      version: profile.version,
      id: profile.id,
      schemaVersion: profile.schemaVersion,
    }
    expect(runnerProfileDigest(reordered)).toBe(runnerProfileDigest(profile))
  })

  it('allows only a current scoped command in the profile allowlist', () => {
    expect(evaluateRunnerCommand({ command, profile, workspace })).toEqual({ allowed: true })
    expect(
      evaluateRunnerCommand({
        command: { ...command, baseCommit: 'd'.repeat(40) },
        profile,
        workspace,
      }),
    ).toMatchObject({ allowed: false, rejectionCode: 'STALE_BINDING' })
    expect(
      evaluateRunnerCommand({
        command: { ...command, executable: 'powershell' },
        profile,
        workspace,
      }),
    ).toMatchObject({ allowed: false, rejectionCode: 'COMMAND_NOT_ALLOWED' })
  })

  it('denies excessive time, filesystem scope, and artifact policy requests', () => {
    expect(
      evaluateRunnerCommand({
        command: { ...command, timeoutMs: 60_001 },
        profile,
        workspace,
      }),
    ).toMatchObject({ rejectionCode: 'TIME_LIMIT_EXCEEDED' })
    expect(
      evaluateRunnerCommand({
        command: { ...command, workingDirectory: 'outside' },
        profile,
        workspace,
      }),
    ).toMatchObject({ rejectionCode: 'FILESYSTEM_DENIED' })
    expect(
      evaluateRunnerCommand({
        command: {
          ...command,
          expectedArtifacts: [
            { path: 'workspace/report.txt', mediaType: 'text/plain', retentionClass: 'test' },
          ],
        },
        profile,
        workspace,
      }),
    ).toMatchObject({ rejectionCode: 'ARTIFACT_POLICY_DENIED' })
  })

  it('does not open a cancelled workspace', () => {
    expect(
      evaluateRunnerCommand({
        command,
        profile,
        workspace: { ...workspace, state: 'cancelled' },
      }),
    ).toMatchObject({ rejectionCode: 'WORKSPACE_NOT_READY' })
  })
})
