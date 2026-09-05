import { z } from 'zod'

import { actorContextV1Schema } from './auth-v1.js'
import { schemaVersionV1 } from './common.js'
import {
  runnerCancellationRequestV1Schema,
  runnerCleanupRequestV1Schema,
  runnerExecutionCommandV1Schema,
  runnerWorkspaceRequestV1Schema,
} from './runner-v1.js'

export const RUNNER_DISPATCH_ARTIFACT_MEDIA_TYPE =
  'application/vnd.ai-website-engineering.runner-dispatch+json'
export const RUNNER_DISPATCH_ARTIFACT_RETENTION_CLASS = 'runner-dispatch-command'

const runnerDispatchBaseV1Schema = z.object({
  schemaVersion: schemaVersionV1,
  actor: actorContextV1Schema,
})

export const runnerDispatchEnvelopeV1Schema = z
  .discriminatedUnion('operation', [
    runnerDispatchBaseV1Schema
      .extend({
        operation: z.literal('prepare'),
        request: runnerWorkspaceRequestV1Schema,
      })
      .strict(),
    runnerDispatchBaseV1Schema
      .extend({
        operation: z.literal('execute'),
        request: runnerExecutionCommandV1Schema,
      })
      .strict(),
    runnerDispatchBaseV1Schema
      .extend({
        operation: z.literal('cancel'),
        request: runnerCancellationRequestV1Schema,
      })
      .strict(),
    runnerDispatchBaseV1Schema
      .extend({
        operation: z.literal('cleanup'),
        request: runnerCleanupRequestV1Schema,
      })
      .strict(),
  ])
  .superRefine((envelope, context) => {
    const requestContext = envelope.request.context
    if (envelope.actor.actorType !== 'service') {
      context.addIssue({
        code: 'custom',
        path: ['actor', 'actorType'],
        message: 'Runner dispatch requires a service actor.',
      })
    }
    if (
      envelope.actor.organizationId !== requestContext.organizationId ||
      `service:${envelope.actor.actorId}` !== requestContext.actorRef ||
      envelope.actor.correlationId !== requestContext.correlationId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['request', 'context'],
        message: 'Runner request attribution must match the service actor.',
      })
    }
  })

export type RunnerDispatchEnvelopeV1 = z.infer<typeof runnerDispatchEnvelopeV1Schema>
