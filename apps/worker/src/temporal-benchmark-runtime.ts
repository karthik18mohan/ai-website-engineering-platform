import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Connection, WorkflowClient } from '@temporalio/client'
import { NativeConnection, Worker } from '@temporalio/worker'

import * as activities from './temporal-benchmark-activities.js'
import { TEMPORAL_BENCHMARK_TASK_QUEUE } from './temporal-benchmark-contract.js'

export interface TemporalBenchmarkCloudConfig {
  readonly address: string
  readonly credential: string
  readonly namespace: string
}

export function loadTemporalBenchmarkCloudConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TemporalBenchmarkCloudConfig {
  const address = environment['TEMPORAL_ADDRESS']
  const credential = environment['TEMPORAL_API_KEY']
  const namespace = environment['TEMPORAL_NAMESPACE']
  if (address === undefined || credential === undefined || namespace === undefined) {
    throw new Error(
      'Temporal benchmark requires non-production address, namespace, and API-key references.',
    )
  }
  if (!namespace.includes('nonprod') || !address.endsWith('.tmprl.cloud:7233')) {
    throw new Error(
      'Temporal benchmark configuration is restricted to the approved non-production Cloud namespace.',
    )
  }
  return { address, credential, namespace }
}

export async function createTemporalBenchmarkClient(config: TemporalBenchmarkCloudConfig) {
  const { credential: apiKey } = config
  const connection = await Connection.connect({
    address: config.address,
    apiKey,
    tls: true,
  })
  return { client: new WorkflowClient({ connection, namespace: config.namespace }), connection }
}

export async function runTemporalBenchmarkWorker(
  config: TemporalBenchmarkCloudConfig,
): Promise<void> {
  const { credential: apiKey } = config
  const connection = await NativeConnection.connect({
    address: config.address,
    apiKey,
    tls: true,
  })
  const compiledWorkflowUrl = new URL('./temporal-benchmark-workflow.js', import.meta.url)
  const workflowUrl = existsSync(compiledWorkflowUrl)
    ? compiledWorkflowUrl
    : new URL('./temporal-benchmark-workflow.ts', import.meta.url)
  const worker = await Worker.create({
    activities,
    connection,
    namespace: config.namespace,
    taskQueue: TEMPORAL_BENCHMARK_TASK_QUEUE,
    workflowsPath: fileURLToPath(workflowUrl),
  })
  try {
    await worker.run()
  } finally {
    await connection.close()
  }
}
