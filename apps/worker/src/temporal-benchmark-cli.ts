import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client'

import {
  TEMPORAL_BENCHMARK_TASK_QUEUE,
  TEMPORAL_BENCHMARK_WORKFLOW_ID_PREFIX,
  temporalBenchmarkInputSchema,
  temporalBenchmarkScenarios,
} from './temporal-benchmark-contract.js'
import {
  createTemporalBenchmarkClient,
  loadTemporalBenchmarkCloudConfig,
} from './temporal-benchmark-runtime.js'
import {
  benchmarkApprovalSignal,
  benchmarkProgressQuery,
  temporalDurabilityBenchmark,
} from './temporal-benchmark-workflow.js'

const [operation, key, option] = process.argv.slice(2)
if (operation === undefined || key === undefined || !/^[a-zA-Z0-9._-]{8,80}$/u.test(key)) {
  throw new Error(
    'Usage: benchmark:temporal <start|status|approve|reject|cancel> <run-key> [scenario]',
  )
}

const config = loadTemporalBenchmarkCloudConfig()
const { client, connection } = await createTemporalBenchmarkClient(config)
const workflowId = `${TEMPORAL_BENCHMARK_WORKFLOW_ID_PREFIX}-${key}`

try {
  if (operation === 'start') {
    if (option === undefined || !temporalBenchmarkScenarios.includes(option as never)) {
      throw new Error('A supported benchmark scenario is required.')
    }
    const input = temporalBenchmarkInputSchema.parse({
      payload: syntheticPayload(option === 'payload' ? 1_048_576 : 1_024),
      runKey: key,
      scenario: option,
      sleepMs: 60_000,
    })
    try {
      const handle = await client.start(temporalDurabilityBenchmark, {
        args: [input],
        taskQueue: TEMPORAL_BENCHMARK_TASK_QUEUE,
        workflowId,
      })
      write({ operation, runId: handle.firstExecutionRunId, workflowId })
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error
      write({ operation, replay: true, workflowId })
    }
  } else {
    const handle = client.getHandle<typeof temporalDurabilityBenchmark>(workflowId)
    if (operation === 'approve' || operation === 'reject') {
      await handle.signal(benchmarkApprovalSignal, operation === 'approve', 'benchmark-operator')
      write({ operation, workflowId })
    } else if (operation === 'cancel') {
      await handle.cancel()
      write({ operation, workflowId })
    } else if (operation === 'status') {
      const description = await handle.describe()
      const status = description.status.name
      const progress = status === 'RUNNING' ? await handle.query(benchmarkProgressQuery) : undefined
      const result = status === 'COMPLETED' ? await handle.result() : undefined
      write({ operation, progress, result, status, workflowId })
    } else {
      throw new Error('Unsupported Temporal benchmark operation.')
    }
  }
} finally {
  await connection.close()
}

function syntheticPayload(bytes: number) {
  return '0123456789abcdef'.repeat(Math.ceil(bytes / 16)).slice(0, bytes)
}

function write(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
