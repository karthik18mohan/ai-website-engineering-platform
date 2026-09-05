import { createHash } from 'node:crypto'

import { Context } from '@temporalio/activity'
import { ApplicationFailure } from '@temporalio/common'

import type { TemporalBenchmarkStepResult } from './temporal-benchmark-contract.js'

export async function measureActivity(
  label: string,
  payload: string,
): Promise<TemporalBenchmarkStepResult> {
  const startedAt = Date.now()
  await Promise.resolve()
  return {
    attempt: Context.current().info.attempt,
    digest: createHash('sha256').update(payload).digest('hex'),
    durationMs: Date.now() - startedAt,
    label,
    payloadBytes: Buffer.byteLength(payload),
  }
}

export async function transientFailureActivity(): Promise<TemporalBenchmarkStepResult> {
  const { attempt } = Context.current().info
  await Promise.resolve()
  if (attempt === 1) throw ApplicationFailure.retryable('Injected benchmark transient failure.')
  return {
    attempt,
    digest: 'recovered',
    durationMs: 0,
    label: 'transient-recovery',
    payloadBytes: 0,
  }
}

export async function permanentFailureActivity(): Promise<never> {
  await Promise.resolve()
  throw ApplicationFailure.nonRetryable('Injected benchmark permanent failure.')
}
