import type { PlatformDatabase } from '@platform/database'
import {
  RunnerOrchestrationService,
  type ArtifactReaderPort,
  type RunnerProviderPort,
} from '@platform/domain'

import {
  PostgresDurableDispatch,
  type PostgresDurableDispatchOptions,
} from './postgres-durable-dispatch.js'
import { PostgresRunnerOrchestrationStore } from './postgres-runner-orchestration-store.js'
import {
  RunnerDispatchHandler,
  type RunnerDispatchHandlerOptions,
} from './runner-dispatch-handler.js'
import type { WorkerConfig } from './config.js'
import { WorkerRuntime } from './runtime.js'

export interface RunnerDispatchRuntimeOptions {
  readonly artifacts: ArtifactReaderPort
  readonly database: PlatformDatabase
  readonly dispatch?: PostgresDurableDispatchOptions
  readonly handler?: RunnerDispatchHandlerOptions
  readonly onDispatchError?: (error: unknown) => void
  readonly pollIntervalMs?: number
  readonly runner: RunnerProviderPort
  readonly workerId: string
}

export interface RunnerDispatchDependencies {
  readonly artifacts: ArtifactReaderPort
  readonly database: PlatformDatabase
  readonly dispatch?: PostgresDurableDispatchOptions
  readonly handler?: RunnerDispatchHandlerOptions
  readonly onDispatchError?: (error: unknown) => void
  readonly runner: RunnerProviderPort
}

/**
 * Worker-owned composition root for durable runner commands. Provider and
 * protected-artifact adapters remain injected so server activation cannot
 * silently fall back to an unprotected local implementation.
 */
export function createRunnerDispatchRuntime(options: RunnerDispatchRuntimeOptions): WorkerRuntime {
  const service = new RunnerOrchestrationService({
    runner: options.runner,
    store: new PostgresRunnerOrchestrationStore(options.database),
  })
  const handler = new RunnerDispatchHandler(options.artifacts, service, options.handler)
  const queue = new PostgresDurableDispatch(options.database, options.dispatch)
  return new WorkerRuntime({
    dispatch: {
      runOne: (workerId) => queue.runOne(workerId, handler),
    },
    ...(options.onDispatchError === undefined ? {} : { onDispatchError: options.onDispatchError }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    workerId: options.workerId,
  })
}

/**
 * Server activation is explicit and fail-closed. A deployment cannot enable
 * durable runner dispatch until protected artifact and isolation providers are
 * supplied by its composition root.
 */
export function createConfiguredWorkerRuntime(
  config: WorkerConfig,
  dependencies?: RunnerDispatchDependencies,
): WorkerRuntime {
  if (!config.runnerDispatchEnabled) return new WorkerRuntime({ workerId: config.workerId })
  if (dependencies === undefined) {
    throw new Error(
      'Runner dispatch is enabled but protected artifact and isolation providers are not composed.',
    )
  }
  return createRunnerDispatchRuntime({
    ...dependencies,
    pollIntervalMs: config.runnerDispatchPollIntervalMs,
    workerId: config.workerId,
  })
}
