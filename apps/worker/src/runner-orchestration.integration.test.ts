import type {
  ActorContextV1,
  PlanningResultV1,
  RunnerExecutionCommandV1,
  RunnerIsolationProfileV1,
  RunnerWorkspaceRequestV1,
} from '@platform/contracts'
import {
  RunnerOrchestrationService,
  runnerProfileDigest,
  type PersistedRunnerCommand,
  type PersistedRunnerLifecycle,
  type PersistedRunnerWorkspace,
  type RunnerAuditEvent,
  type RunnerOrchestrationStore,
  type RunnerWorkspaceContext,
} from '@platform/domain'
import { ConformanceRunnerFixture } from '@platform/provider-framework'
import { describe, expect, it } from 'vitest'

const organizationId = id('1')
const projectId = id('2')
const actorId = id('3')
const runId = id('4')
const planId = id('5')
const workspaceIdempotency = 'workspace-idempotency'
const baseCommit = 'a'.repeat(40)
const now = new Date('2026-08-11T14:00:00.000Z')

const actor: ActorContextV1 = {
  schemaVersion: '1',
  actorId,
  actorType: 'service',
  authenticationMethod: 'test',
  correlationId: id('6'),
  issuedAt: now.toISOString(),
  organizationId,
  sessionId: id('18'),
  subject: 'service:runner',
}

const profile: RunnerIsolationProfileV1 = {
  schemaVersion: '1',
  id: id('7'),
  version: 'm08-fixture-v1',
  backendClass: 'conformance_fixture',
  image: { reference: 'fixture.invalid/runner', digest: 'b'.repeat(64) },
  resources: {
    cpuMillicores: 500,
    memoryMiB: 512,
    timeoutMs: 60_000,
    maxProcesses: 16,
    maxFiles: 10_000,
    maxBytes: 10_000_000,
  },
  filesystem: { denyHostFilesystem: true, writableRoots: ['workspace'] },
  processes: { shell: false, allowedCommands: [{ tool: 'npm', executable: 'npm' }] },
  network: { mode: 'denied' },
  dependencies: {
    approvedRegistries: [],
    installScripts: 'denied',
    allowedInstallScripts: [],
  },
  secrets: { allowProductionSecrets: false, allowedReferenceKeys: [] },
  artifacts: {
    maxCount: 10,
    maxBytes: 1_000_000,
    allowedMediaTypes: ['application/json'],
    retentionClasses: ['test-evidence'],
  },
}

const workspaceRequest: RunnerWorkspaceRequestV1 = {
  schemaVersion: '1',
  context: {
    schemaVersion: '1',
    organizationId,
    projectId,
    actorRef: `service:${actorId}`,
    correlationId: actor.correlationId,
    idempotencyKey: workspaceIdempotency,
    requestedAt: now.toISOString(),
  },
  runId,
  executionPlanId: planId,
  repository: { provider: 'github', repositoryId: 'fixture-repository' },
  baseCommit,
  profile,
}

describe('M08 runner orchestration', () => {
  it('reauthorizes a current approved queued run immediately before provision', async () => {
    const store = new MemoryRunnerStore(planning())
    const service = new RunnerOrchestrationService({
      clock: () => now,
      runner: new ConformanceRunnerFixture(() => now),
      store,
    })

    const first = await service.prepare(actor, workspaceRequest)
    const replay = await service.prepare(actor, workspaceRequest)

    expect(replay).toEqual(first)
    expect(store.workspace?.workspace.state).toBe('ready')
    expect(store.workspaceContext?.run.state).toBe('PREPARING')
    expect(store.audit.map(({ action, outcome }) => [action, outcome])).toEqual(
      expect.arrayContaining([
        ['authorization.run:execute', 'allowed'],
        ['run.started', 'succeeded'],
      ]),
    )
  })

  it('stops before provision when approval, policy, or service authority is stale', async () => {
    const stale = planning()
    stale.approvals[0] = {
      ...stale.approvals[0]!,
      decision: 'pending',
      approverId: undefined,
      rationale: undefined,
      decidedAt: undefined,
    }
    const store = new MemoryRunnerStore(stale)
    const runner = new CountingRunner(() => now)
    const service = new RunnerOrchestrationService({ clock: () => now, runner, store })
    await expect(service.prepare(actor, workspaceRequest)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(runner.provisionCount).toBe(0)
    expect(store.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'runner.provision', outcome: 'denied' }),
      ]),
    )

    store.grantActive = false
    await expect(service.prepare(actor, workspaceRequest)).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    })
    expect(runner.provisionCount).toBe(0)
  })

  it('persists command, cancellation, cleanup, and artifact references idempotently', async () => {
    const store = new MemoryRunnerStore(planning())
    const service = new RunnerOrchestrationService({
      clock: () => now,
      runner: new ConformanceRunnerFixture(() => now),
      store,
    })
    const workspace = await service.prepare(actor, workspaceRequest)
    const command: RunnerExecutionCommandV1 = {
      schemaVersion: '1',
      context: { ...workspaceRequest.context, idempotencyKey: 'command-idempotency' },
      id: id('8'),
      workspaceId: workspace.id,
      runId,
      baseCommit,
      profileDigest: runnerProfileDigest(profile),
      tool: 'npm',
      executable: 'npm',
      arguments: ['test'],
      workingDirectory: 'workspace',
      timeoutMs: 30_000,
      expectedArtifacts: [],
    }
    const result = await service.execute(actor, command)
    expect(await service.execute(actor, command)).toEqual(result)
    expect(store.command?.result.status).toBe('succeeded')
    expect(store.workspaceContext?.run.state).toBe('IMPLEMENTING')

    const cancellation = {
      schemaVersion: '1' as const,
      context: { ...workspaceRequest.context, idempotencyKey: 'cancel-idempotency' },
      workspaceId: workspace.id,
      runId,
      reason: 'Requested by orchestration test.',
    }
    const cancelled = await service.cancel(actor, cancellation)
    expect(await service.cancel(actor, cancellation)).toEqual(cancelled)
    expect(store.workspaceContext?.run.state).toBe('CANCELLED')

    const cleanup = {
      schemaVersion: '1' as const,
      context: { ...workspaceRequest.context, idempotencyKey: 'cleanup-idempotency' },
      workspaceId: workspace.id,
      runId,
    }
    const destroyed = await service.cleanup(actor, cleanup)
    expect(await service.cleanup(actor, cleanup)).toEqual(destroyed)
    expect(store.lifecycle.get('cleanup:cleanup-idempotency')?.result.status).toBe('destroyed')
  })
})

class CountingRunner extends ConformanceRunnerFixture {
  provisionCount = 0

  override provision(request: RunnerWorkspaceRequestV1) {
    this.provisionCount += 1
    return super.provision(request)
  }
}

class MemoryRunnerStore implements RunnerOrchestrationStore {
  audit: RunnerAuditEvent[] = []
  command?: PersistedRunnerCommand
  grantActive = true
  lifecycle = new Map<string, PersistedRunnerLifecycle>()
  workspace?: PersistedRunnerWorkspace
  workspaceContext?: RunnerWorkspaceContext

  constructor(private readonly planningResult: PlanningResultV1) {}

  findServiceGrant() {
    return Promise.resolve({
      actorId,
      organizationId,
      projectId,
      permissions: this.grantActive ? (['run:execute'] as const) : ([] as const),
      status: 'active' as const,
    })
  }

  findPreparationContext() {
    return Promise.resolve({
      planning: this.planningResult,
      currentPolicyVersion: this.planningResult.plan.policySnapshot.policyVersion,
      repository: {
        provider: 'github',
        repositoryId: 'fixture-repository',
        indexedCommit: baseCommit,
        readiness: 'ready' as const,
      },
    })
  }

  findWorkspaceByIdempotencyKey() {
    return Promise.resolve(this.workspace)
  }

  findWorkspaceContext() {
    return Promise.resolve(this.workspaceContext)
  }

  savePreparedWorkspace(input: Parameters<RunnerOrchestrationStore['savePreparedWorkspace']>[0]) {
    this.workspace = {
      requestDigest: input.requestDigest,
      profile: input.profile,
      workspace: input.workspace,
    }
    this.workspaceContext = { ...this.workspace, run: input.run }
    this.audit.push(...input.auditEvents)
    return Promise.resolve()
  }

  findCommandByIdempotencyKey() {
    return Promise.resolve(this.command)
  }

  saveExecution(input: Parameters<RunnerOrchestrationStore['saveExecution']>[0]) {
    this.command = { requestDigest: input.requestDigest, result: input.result }
    this.workspaceContext = { ...this.workspaceContext!, run: input.run }
    this.audit.push(...input.auditEvents)
    return Promise.resolve()
  }

  findLifecycleByIdempotencyKey(
    _organizationId: string,
    _projectId: string,
    idempotencyKey: string,
    action: 'cancel' | 'cleanup',
  ) {
    return Promise.resolve(this.lifecycle.get(`${action}:${idempotencyKey}`))
  }

  saveLifecycle(input: Parameters<RunnerOrchestrationStore['saveLifecycle']>[0]) {
    this.lifecycle.set(`${input.action}:${input.idempotencyKey}`, {
      requestDigest: input.requestDigest,
      result: input.result,
    })
    if (input.run !== undefined)
      this.workspaceContext = { ...this.workspaceContext!, run: input.run }
    this.audit.push(...input.auditEvents)
    return Promise.resolve()
  }

  appendAuditEvent(event: RunnerAuditEvent) {
    this.audit.push(event)
    return Promise.resolve()
  }
}

function planning(): PlanningResultV1 {
  const policySnapshot = {
    schemaVersion: '1' as const,
    id: id('9'),
    organizationId,
    projectId,
    policyId: id('10'),
    policyVersion: 'policy-current',
    target: 'preview' as const,
    productionPromotionEnabled: false,
    mediumRiskRequiresApproval: false,
    separationOfDuties: true,
    capturedAt: now.toISOString(),
    digest: 'c'.repeat(64),
  }
  return {
    schemaVersion: '1',
    plan: {
      schemaVersion: '1',
      id: planId,
      organizationId,
      projectId,
      changeRequestId: id('11'),
      requirementId: id('12'),
      baseCommit,
      revision: 1,
      riskClass: 'high',
      riskSignals: ['authentication'],
      expectedImpact: ['Fixture impact'],
      requiredAnalyses: ['security'],
      analyses: [
        {
          schemaVersion: '1',
          analysis: 'security',
          status: 'completed',
          requirementId: id('12'),
          baseCommit,
          policySnapshotDigest: policySnapshot.digest,
          summary: 'Reviewed.',
          evidenceRefs: ['artifact://security'],
          threatFindings: ['Authentication boundary'],
          requiredControls: ['Current approval'],
        },
      ],
      tasks: [
        {
          id: 'task-1',
          objective: 'Edit fixture.',
          expectedFiles: ['src/fixture.ts'],
          dependencies: [],
          validations: ['Run tests.'],
        },
      ],
      requestedApprovals: ['plan_execution'],
      rollbackConsiderations: ['Revert fixture.'],
      estimatedUsage: {
        estimateId: id('13'),
        budgetDecisionId: id('14'),
        source: 'fixture',
        inputTokens: 0,
        outputTokens: 0,
        durationSeconds: 0,
        costAmount: '0',
        currency: 'USD',
        pricingVersion: 'fixture',
      },
      policySnapshot,
      createdAt: now.toISOString(),
    },
    run: {
      schemaVersion: '1',
      id: runId,
      organizationId,
      projectId,
      changeRequestId: id('11'),
      executionPlanId: planId,
      baseCommit,
      state: 'QUEUED',
      policySnapshot,
      createdAt: now.toISOString(),
    },
    approvals: [
      {
        schemaVersion: '1',
        id: id('15'),
        organizationId,
        projectId,
        runId,
        planId,
        planRevision: 1,
        gate: 'plan_execution',
        decision: 'approved',
        requesterId: id('16'),
        approverId: id('17'),
        rationale: 'Approved.',
        policyVersion: policySnapshot.policyVersion,
        requestedAt: now.toISOString(),
        decidedAt: now.toISOString(),
      },
    ],
  }
}

function id(seed: string) {
  return `00000000-0000-4000-8000-${seed.padStart(12, '0')}`
}
