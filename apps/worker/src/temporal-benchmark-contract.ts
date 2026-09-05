import { z } from 'zod'

export const temporalBenchmarkScenarios = [
  'basic',
  'transient-failure',
  'durable-sleep',
  'approval',
  'parallel',
  'permanent-failure',
  'replay-recovery',
  'payload',
] as const

export const temporalBenchmarkInputSchema = z
  .object({
    payload: z.string().max(1_048_576),
    runKey: z.string().regex(/^[a-zA-Z0-9._-]{8,80}$/u),
    scenario: z.enum(temporalBenchmarkScenarios),
    sleepMs: z.number().int().min(1).max(86_400_000),
  })
  .strict()

export type TemporalBenchmarkInput = z.infer<typeof temporalBenchmarkInputSchema>

export interface TemporalBenchmarkStepResult {
  readonly attempt: number
  readonly digest: string
  readonly durationMs: number
  readonly label: string
  readonly payloadBytes: number
}

export interface TemporalBenchmarkResult {
  readonly engine: 'temporal'
  readonly input: TemporalBenchmarkInput
  readonly steps: readonly TemporalBenchmarkStepResult[]
}

export const TEMPORAL_BENCHMARK_TASK_QUEUE = 'm08-durability-benchmark-v1'
export const TEMPORAL_BENCHMARK_WORKFLOW_ID_PREFIX = 'm08-benchmark'
