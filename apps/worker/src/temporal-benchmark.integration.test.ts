import { DefaultLogger, Runtime, Worker } from '@temporalio/worker'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as activities from './temporal-benchmark-activities.js'
import {
  TEMPORAL_BENCHMARK_TASK_QUEUE,
  type TemporalBenchmarkInput,
} from './temporal-benchmark-contract.js'
import {
  benchmarkApprovalSignal,
  temporalDurabilityBenchmark,
} from './temporal-benchmark-workflow.js'

Runtime.install({ logger: new DefaultLogger('ERROR', () => undefined) })

describe('Temporal durability benchmark', () => {
  let environment: TestWorkflowEnvironment | undefined
  beforeEach(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping()
  }, 60_000)
  afterEach(async () => environment?.teardown())

  it('executes equivalent basic, parallel, payload, retry, sleep, and approval scenarios', async () => {
    if (environment === undefined) throw new Error('Temporal test environment is unavailable.')
    const testEnvironment = environment
    const worker = await Worker.create({
      activities,
      connection: testEnvironment.nativeConnection,
      taskQueue: TEMPORAL_BENCHMARK_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL('./temporal-benchmark-workflow.ts', import.meta.url)),
    })
    await worker.runUntil(async () => {
      for (const [scenario, payload] of [
        ['basic', 'fixture'],
        ['parallel', 'fixture'],
        ['payload', 'x'.repeat(262_144)],
        ['transient-failure', 'fixture'],
        ['durable-sleep', 'fixture'],
      ] as const) {
        const result = await testEnvironment.client.workflow.execute(temporalDurabilityBenchmark, {
          args: [input(scenario, payload)],
          taskQueue: TEMPORAL_BENCHMARK_TASK_QUEUE,
          workflowId: `test-${scenario}`,
        })
        expect(result.engine).toBe('temporal')
        if (scenario === 'transient-failure') expect(result.steps.at(-1)?.attempt).toBe(2)
      }
      const approval = await testEnvironment.client.workflow.start(temporalDurabilityBenchmark, {
        args: [input('approval')],
        taskQueue: TEMPORAL_BENCHMARK_TASK_QUEUE,
        workflowId: 'test-approval',
      })
      await approval.signal(benchmarkApprovalSignal, true, 'fixture')
      await expect(approval.result()).resolves.toMatchObject({ engine: 'temporal' })
    })
  }, 60_000)

  it('records permanent failure and cancellation semantics', async () => {
    if (environment === undefined) throw new Error('Temporal test environment is unavailable.')
    const testEnvironment = environment
    const worker = await Worker.create({
      activities,
      connection: testEnvironment.nativeConnection,
      taskQueue: TEMPORAL_BENCHMARK_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL('./temporal-benchmark-workflow.ts', import.meta.url)),
    })
    await worker.runUntil(async () => {
      await expect(
        testEnvironment.client.workflow.execute(temporalDurabilityBenchmark, {
          args: [input('permanent-failure')],
          taskQueue: TEMPORAL_BENCHMARK_TASK_QUEUE,
          workflowId: 'test-permanent',
        }),
      ).rejects.toThrow()
      const waiting = await testEnvironment.client.workflow.start(temporalDurabilityBenchmark, {
        args: [input('approval')],
        taskQueue: TEMPORAL_BENCHMARK_TASK_QUEUE,
        workflowId: 'test-cancel',
      })
      await waiting.cancel()
      await expect(waiting.result()).rejects.toThrow(/cancel/u)
    })
  }, 60_000)
})

function input(
  scenario: TemporalBenchmarkInput['scenario'],
  payload = 'fixture',
): TemporalBenchmarkInput {
  return { payload, runKey: `benchmark-${scenario}`, scenario, sleepMs: 60_000 }
}
import { fileURLToPath } from 'node:url'
