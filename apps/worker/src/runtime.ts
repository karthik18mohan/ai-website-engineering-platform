export type WorkerLifecycleState = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped'

export interface WorkerDispatchRunner {
  runOne(workerId: string): Promise<boolean>
}

export interface WorkerRuntimeOptions {
  readonly dispatch?: WorkerDispatchRunner
  readonly onDispatchError?: (error: unknown) => void
  readonly pollIntervalMs?: number
  readonly workerId?: string
}

/**
 * Process lifecycle plus an optional durable dispatch pump. The runtime never
 * interprets command artifacts or executes untrusted repository code itself.
 */
export class WorkerRuntime {
  readonly #dispatch: WorkerDispatchRunner | undefined
  readonly #onDispatchError: (error: unknown) => void
  readonly #pollIntervalMs: number
  readonly #workerId: string
  #activeTick: Promise<void> | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #state: WorkerLifecycleState = 'idle'

  constructor(options: WorkerRuntimeOptions = {}) {
    this.#dispatch = options.dispatch
    this.#onDispatchError = options.onDispatchError ?? (() => undefined)
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.#workerId = options.workerId ?? 'worker-local'
    if (!Number.isInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 10) {
      throw new Error('Worker poll interval must be an integer of at least 10 ms.')
    }
    if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(this.#workerId)) {
      throw new Error('Worker ID is invalid.')
    }
  }

  get state(): WorkerLifecycleState {
    return this.#state
  }

  get ready(): boolean {
    return this.#state === 'ready'
  }

  async start(): Promise<void> {
    if (this.#state !== 'idle' && this.#state !== 'stopped') {
      throw new Error(`Worker cannot start from ${this.#state}.`)
    }

    this.#state = 'starting'
    await Promise.resolve()
    this.#state = 'ready'
    this.#schedule(0)
  }

  async stop(): Promise<void> {
    if (this.#state === 'stopped') return
    if (this.#state !== 'ready' && this.#state !== 'starting' && this.#state !== 'idle') {
      throw new Error(`Worker cannot stop from ${this.#state}.`)
    }

    this.#state = 'stopping'
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    await this.#activeTick
    this.#state = 'stopped'
  }

  #schedule(delayMs: number): void {
    if (this.#dispatch === undefined || this.#state !== 'ready') return
    this.#timer = setTimeout(() => {
      this.#activeTick = this.#tick().finally(() => {
        this.#activeTick = undefined
        this.#schedule(this.#pollIntervalMs)
      })
    }, delayMs)
  }

  async #tick(): Promise<void> {
    try {
      await this.#dispatch?.runOne(this.#workerId)
    } catch (error) {
      this.#onDispatchError(error)
    }
  }
}
