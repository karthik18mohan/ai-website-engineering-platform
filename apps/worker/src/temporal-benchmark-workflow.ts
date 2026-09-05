import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow'

import type * as activities from './temporal-benchmark-activities.js'
import type {
  TemporalBenchmarkInput,
  TemporalBenchmarkResult,
  TemporalBenchmarkStepResult,
} from './temporal-benchmark-contract.js'

const { measureActivity, permanentFailureActivity, transientFailureActivity } = proxyActivities<
  typeof activities
>({
  retry: { initialInterval: 10, maximumAttempts: 3 },
  startToCloseTimeout: '30 seconds',
})

export const benchmarkApprovalSignal = defineSignal<[boolean, string]>('benchmarkApproval')
export const benchmarkProgressQuery = defineQuery<{
  readonly approved: boolean | undefined
  readonly completedSteps: number
}>('benchmarkProgress')

export async function temporalDurabilityBenchmark(
  input: TemporalBenchmarkInput,
): Promise<TemporalBenchmarkResult> {
  let approved: boolean | undefined
  let reviewer = ''
  const steps: TemporalBenchmarkStepResult[] = []
  setHandler(benchmarkApprovalSignal, (decision, actor) => {
    approved = decision
    reviewer = actor
  })
  setHandler(benchmarkProgressQuery, () => ({ approved, completedSteps: steps.length }))

  steps.push(await measureActivity('start', input.payload))
  if (input.scenario === 'transient-failure' || input.scenario === 'replay-recovery') {
    steps.push(await transientFailureActivity())
    return result(input, steps)
  }
  if (input.scenario === 'durable-sleep') {
    await sleep(input.sleepMs)
    steps.push(await measureActivity('after-sleep', input.payload))
    return result(input, steps)
  }
  if (input.scenario === 'approval') {
    await condition(() => approved !== undefined)
    if (approved !== true) throw new Error('Benchmark approval was rejected.')
    steps.push(await measureActivity(`approved:${reviewer}`, input.payload))
    return result(input, steps)
  }
  if (input.scenario === 'parallel') {
    steps.push(
      ...(await Promise.all([
        measureActivity('parallel-a', input.payload),
        measureActivity('parallel-b', input.payload),
        measureActivity('parallel-c', input.payload),
      ])),
    )
    return result(input, steps)
  }
  if (input.scenario === 'permanent-failure') await permanentFailureActivity()
  steps.push(await measureActivity('complete', input.payload))
  return result(input, steps)
}

function result(
  input: TemporalBenchmarkInput,
  steps: readonly TemporalBenchmarkStepResult[],
): TemporalBenchmarkResult {
  return { engine: 'temporal', input, steps }
}
