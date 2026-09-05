import { describe, expect, it } from 'vitest'

import { WorkerRuntime } from './runtime.js'

describe('worker process lifecycle', () => {
  it('enters and leaves readiness deterministically', async () => {
    const runtime = new WorkerRuntime()
    expect(runtime.ready).toBe(false)

    await runtime.start()
    expect(runtime.state).toBe('ready')
    expect(runtime.ready).toBe(true)

    await runtime.stop()
    expect(runtime.state).toBe('stopped')
    expect(runtime.ready).toBe(false)
  })

  it('rejects a duplicate start while already ready', async () => {
    const runtime = new WorkerRuntime()
    await runtime.start()
    await expect(runtime.start()).rejects.toThrow(/cannot start from ready/)
  })

  it('pumps one durable dispatch at a time and waits for the active poll during shutdown', async () => {
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const firstPoll = new Promise<void>((resolve) => {
      started = resolve
    })
    let calls = 0
    const runtime = new WorkerRuntime({
      dispatch: {
        async runOne(workerId) {
          expect(workerId).toBe('worker-test')
          calls += 1
          started()
          await entered
          return true
        },
      },
      pollIntervalMs: 10,
      workerId: 'worker-test',
    })
    await runtime.start()
    await firstPoll
    const stopping = runtime.stop()
    expect(runtime.state).toBe('stopping')
    expect(calls).toBe(1)
    release()
    await stopping
    expect(runtime.state).toBe('stopped')
    expect(calls).toBe(1)
  })
})
