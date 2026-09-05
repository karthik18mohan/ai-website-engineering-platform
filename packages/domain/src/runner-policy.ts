import { createHash } from 'node:crypto'

import type {
  RunnerExecutionCommandV1,
  RunnerExecutionResultV1,
  RunnerIsolationProfileV1,
  RunnerWorkspaceV1,
} from '@platform/contracts'

export type RunnerCommandPolicyDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly rejectionCode: NonNullable<RunnerExecutionResultV1['rejectionCode']>
    }

export function runnerProfileDigest(profile: RunnerIsolationProfileV1): string {
  return createHash('sha256').update(canonicalJson(profile)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function evaluateRunnerCommand(input: {
  readonly workspace: RunnerWorkspaceV1
  readonly profile: RunnerIsolationProfileV1
  readonly command: RunnerExecutionCommandV1
}): RunnerCommandPolicyDecision {
  const { command, profile, workspace } = input
  if (workspace.state !== 'ready') return denied('WORKSPACE_NOT_READY')
  if (
    command.context.organizationId !== workspace.organizationId ||
    command.context.projectId !== workspace.projectId ||
    command.workspaceId !== workspace.id ||
    command.runId !== workspace.runId ||
    command.baseCommit !== workspace.baseCommit ||
    command.profileDigest !== workspace.profileDigest ||
    runnerProfileDigest(profile) !== workspace.profileDigest
  ) {
    return denied('STALE_BINDING')
  }
  if (
    !profile.processes.allowedCommands.some(
      ({ executable, tool }) => executable === command.executable && tool === command.tool,
    )
  ) {
    return denied('COMMAND_NOT_ALLOWED')
  }
  if (command.timeoutMs > profile.resources.timeoutMs) return denied('TIME_LIMIT_EXCEEDED')
  if (
    !profile.filesystem.writableRoots.some(
      (root) =>
        root === '.' ||
        command.workingDirectory === root ||
        command.workingDirectory.startsWith(`${root}/`),
    )
  ) {
    return denied('FILESYSTEM_DENIED')
  }
  if (
    command.expectedArtifacts.length > profile.artifacts.maxCount ||
    command.expectedArtifacts.some(
      ({ mediaType, retentionClass }) =>
        !profile.artifacts.allowedMediaTypes.includes(mediaType) ||
        !profile.artifacts.retentionClasses.includes(retentionClass),
    )
  ) {
    return denied('ARTIFACT_POLICY_DENIED')
  }
  return { allowed: true }
}

function denied(
  rejectionCode: NonNullable<RunnerExecutionResultV1['rejectionCode']>,
): RunnerCommandPolicyDecision {
  return { allowed: false, rejectionCode }
}
