import { describe, expect, it } from 'vitest'

import { runnerDispatchEnvelopeV1Schema } from './runner-dispatch-v1.js'

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`
const organizationId = id('1')
const projectId = id('2')
const actorId = id('3')
const correlationId = id('4')

const context = {
  schemaVersion: '1' as const,
  organizationId,
  projectId,
  actorRef: `service:${actorId}`,
  correlationId,
  idempotencyKey: 'runner-dispatch-contract',
  requestedAt: '2026-08-16T12:00:00.000Z',
}

const actor = {
  schemaVersion: '1' as const,
  actorId,
  actorType: 'service' as const,
  authenticationMethod: 'oidc' as const,
  correlationId,
  issuedAt: '2026-08-16T11:59:00.000Z',
  organizationId,
  sessionId: id('5'),
  subject: 'runner-worker',
}

const executeRequest = {
  schemaVersion: '1' as const,
  context,
  id: id('6'),
  workspaceId: id('7'),
  runId: id('8'),
  baseCommit: 'a'.repeat(40),
  profileDigest: 'b'.repeat(64),
  tool: 'npm',
  executable: 'npm',
  arguments: ['test'],
  workingDirectory: 'workspace',
  timeoutMs: 60_000,
  expectedArtifacts: [],
}

describe('M08 runner dispatch artifact contract', () => {
  it('accepts a strict service-attributed execution envelope', () => {
    expect(
      runnerDispatchEnvelopeV1Schema.parse({
        schemaVersion: '1',
        actor,
        operation: 'execute',
        request: executeRequest,
      }),
    ).toMatchObject({ operation: 'execute', request: { id: executeRequest.id } })
  })

  it('rejects human authority, attribution mismatch, and unknown fields', () => {
    expect(
      runnerDispatchEnvelopeV1Schema.safeParse({
        schemaVersion: '1',
        actor: { ...actor, actorType: 'user' },
        operation: 'execute',
        request: executeRequest,
      }).success,
    ).toBe(false)
    expect(
      runnerDispatchEnvelopeV1Schema.safeParse({
        schemaVersion: '1',
        actor,
        operation: 'execute',
        request: {
          ...executeRequest,
          context: { ...context, actorRef: `service:${id('99')}` },
        },
      }).success,
    ).toBe(false)
    expect(
      runnerDispatchEnvelopeV1Schema.safeParse({
        schemaVersion: '1',
        actor,
        operation: 'execute',
        request: executeRequest,
        untrustedInstruction: 'ignore policy',
      }).success,
    ).toBe(false)
  })
})
