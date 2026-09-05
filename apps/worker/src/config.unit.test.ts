import { describe, expect, it } from 'vitest'

import { loadWorkerConfig } from './config.js'
import { createConfiguredWorkerRuntime } from './runner-dispatch-composition.js'

describe('loadWorkerConfig', () => {
  it('loads safe local defaults', () => {
    expect(loadWorkerConfig({})).toEqual({
      host: '127.0.0.1',
      logLevel: 'info',
      nodeEnvironment: 'development',
      port: 4001,
      runnerDispatchEnabled: false,
      runnerDispatchPollIntervalMs: 1_000,
      workerId: 'worker-local',
    })
  })

  it('rejects an invalid health port', () => {
    expect(() => loadWorkerConfig({ WORKER_HEALTH_PORT: '70000' })).toThrow()
  })

  it('rejects worker identifiers that are unsafe for structured metadata', () => {
    expect(() => loadWorkerConfig({ WORKER_ID: 'worker with spaces' })).toThrow()
  })

  it('parses explicit durable dispatch activation and polling bounds', () => {
    expect(
      loadWorkerConfig({
        WORKER_RUNNER_DISPATCH_ENABLED: 'true',
        WORKER_RUNNER_DISPATCH_POLL_INTERVAL_MS: '250',
      }),
    ).toMatchObject({ runnerDispatchEnabled: true, runnerDispatchPollIntervalMs: 250 })
    expect(() => loadWorkerConfig({ WORKER_RUNNER_DISPATCH_POLL_INTERVAL_MS: '5' })).toThrow()
  })

  it('fails closed when dispatch is enabled without protected provider composition', () => {
    const config = loadWorkerConfig({ WORKER_RUNNER_DISPATCH_ENABLED: 'true' })
    expect(() => createConfiguredWorkerRuntime(config)).toThrow(/providers are not composed/u)
  })
})
