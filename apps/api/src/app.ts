import {
  actorContextV1Schema,
  apiErrorResponseV1Schema,
  changeRequirementResultV1Schema,
  approvalDecisionResultV1Schema,
  correlationIdSchema,
  createChangeRequestV1Schema,
  createExecutionPlanRequestV1Schema,
  createProjectRequestV1Schema,
  decideApprovalRequestV1Schema,
  healthResponseV1Schema,
  githubConnectionInitiationRequestV1Schema,
  githubConnectionInitiationResultV1Schema,
  githubInstallationSelectionV1Schema,
  githubRepositoryReadinessV1Schema,
  projectLifecycleRequestV1Schema,
  projectV1Schema,
  planningResultV1Schema,
  requirementReviewRequestV1Schema,
  requirementSpecV1Schema,
  type DependencyHealthV1,
} from '@platform/contracts'
import { createLazyPostgresConnection } from '@platform/database'
import {
  PlatformError,
  ChangeRequestService,
  PlanningService,
  ProjectService,
  type GithubOnboardingService,
  isPlatformError,
  type AuthenticationCredential,
  type AuthenticationPort,
  type AttachmentScannerPort,
  type ChangeRequestStore,
  type PlannerRolePort,
  type PlanAnalysisRolePort,
  type PlanningStore,
  type ProjectStore,
  type RequirementRolePort,
} from '@platform/domain'
import { createPlatformLogger, resolveCorrelationId } from '@platform/observability'
import Fastify, { LogController } from 'fastify'
import fastifyRawBody from 'fastify-raw-body'
import { z } from 'zod'

import { LocalAuthenticationAdapter, OidcAuthenticationAdapter } from './authentication.js'
import type { ApiConfig } from './config.js'
import { PostgresProjectStore } from './postgres-project-store.js'
import { PostgresChangeRequestStore } from './postgres-change-request-store.js'
import { PostgresPlanningStore } from './postgres-planning-store.js'

const bearerHeaderSchema = z.string().regex(/^Bearer\s+\S+$/iu)

export interface ReadinessProbe {
  readonly name: string
  check(): Promise<DependencyHealthV1>
  close?(): Promise<void>
}

export interface BuildApiOptions {
  readonly authentication?: AuthenticationPort
  readonly config: ApiConfig
  readonly githubOnboardingService?: GithubOnboardingService
  readonly githubWebhookHandler?: {
    handle(
      delivery: {
        readonly deliveryId: string
        readonly eventType: string
        readonly signature: string
      },
      payload: Uint8Array,
    ): Promise<readonly { readonly status: string }[]>
  }
  readonly changeRequestService?: ChangeRequestService
  readonly changeRequestStore?: ChangeRequestStore
  readonly attachmentScanner?: AttachmentScannerPort
  readonly requirementRole?: RequirementRolePort
  readonly plannerRole?: PlannerRolePort
  readonly planAnalysisRole?: PlanAnalysisRolePort
  readonly planningService?: PlanningService
  readonly planningStore?: PlanningStore
  readonly readinessProbe?: ReadinessProbe
  readonly projectStore?: ProjectStore
}

export function buildApi(options: BuildApiOptions) {
  const logger = createPlatformLogger({
    level: options.config.logLevel,
    service: 'control-plane-api',
  })
  const authentication = options.authentication ?? createAuthentication(options.config)
  const readinessProbe = options.readinessProbe ?? createDatabaseReadinessProbe(options.config)
  const projectConnection =
    options.projectStore === undefined && options.config.databaseUrl !== undefined
      ? createLazyPostgresConnection({ databaseUrl: options.config.databaseUrl })
      : undefined
  const projectStore =
    options.projectStore ??
    (projectConnection === undefined
      ? undefined
      : new PostgresProjectStore(projectConnection.database))
  const projectService =
    projectStore === undefined ? undefined : new ProjectService({ store: projectStore })
  const changeRequestStore =
    options.changeRequestStore ??
    (projectConnection === undefined
      ? undefined
      : new PostgresChangeRequestStore(projectConnection.database))
  const changeRequestService =
    options.changeRequestService ??
    (changeRequestStore === undefined ||
    options.attachmentScanner === undefined ||
    options.requirementRole === undefined
      ? undefined
      : new ChangeRequestService({
          store: changeRequestStore,
          scanner: options.attachmentScanner,
          requirementRole: options.requirementRole,
        }))
  const planningStore =
    options.planningStore ??
    (projectConnection === undefined
      ? undefined
      : new PostgresPlanningStore(projectConnection.database))
  const planningService =
    options.planningService ??
    (planningStore === undefined ||
    options.plannerRole === undefined ||
    options.planAnalysisRole === undefined
      ? undefined
      : new PlanningService({
          store: planningStore,
          planner: options.plannerRole,
          analysisRole: options.planAnalysisRole,
        }))
  const app = Fastify({
    genReqId: (request) => resolveCorrelationId(singleHeader(request.headers['x-correlation-id'])),
    logController: new LogController({ disableRequestLogging: true }),
    loggerInstance: logger,
  })
  void app
    .register(fastifyRawBody, { encoding: false, global: false, runFirst: true })
    .after(() => {
      app.post(
        '/v1/providers/github/webhook',
        { config: { rawBody: true } },
        async (request, reply) => {
          const deliveryId = singleHeader(request.headers['x-github-delivery'])
          const eventType = singleHeader(request.headers['x-github-event'])
          const signature = singleHeader(request.headers['x-hub-signature-256'])
          if (
            deliveryId === undefined ||
            !/^[a-zA-Z0-9-]{1,128}$/u.test(deliveryId) ||
            eventType === undefined ||
            signature === undefined ||
            !/^sha256=[a-f0-9]{64}$/u.test(signature) ||
            !(request.rawBody instanceof Buffer)
          ) {
            throw validationFailed(request.id)
          }
          if (options.githubWebhookHandler === undefined) {
            throw new PlatformError({
              code: 'DEPENDENCY_UNAVAILABLE',
              correlationId: request.id,
              retryable: true,
              safeMessage: 'GitHub webhook processing is unavailable.',
            })
          }
          const results = await options.githubWebhookHandler.handle(
            { deliveryId, eventType, signature },
            request.rawBody,
          )
          if (results.every(({ status }) => status === 'rejected')) void reply.code(401)
          return { schemaVersion: '1', results }
        },
      )
    })

  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-correlation-id', request.id)
    done(null, payload)
  })

  app.get('/health/live', (request) =>
    healthResponseV1Schema.parse({
      schemaVersion: '1',
      checks: [],
      correlationId: request.id,
      service: 'control-plane-api',
      status: 'ok',
      timestamp: new Date().toISOString(),
    }),
  )

  app.get('/health/ready', async (request, reply) => {
    const check = await readinessProbe.check()
    const status = check.status === 'unhealthy' ? 'unavailable' : 'ok'
    if (status === 'unavailable') void reply.code(503)

    return healthResponseV1Schema.parse({
      schemaVersion: '1',
      checks: [check],
      correlationId: request.id,
      service: 'control-plane-api',
      status,
      timestamp: new Date().toISOString(),
    })
  })

  app.get('/v1/session', async (request) => {
    const actor = await authenticateRequest(
      request.headers,
      request.id,
      request.ip,
      options.config,
      authentication,
    )
    return actorContextV1Schema.parse(actor)
  })

  app.post('/v1/projects', async (request, reply) => {
    const actor = await authenticateRequest(
      request.headers,
      request.id,
      request.ip,
      options.config,
      authentication,
    )
    const body = parseBody(createProjectRequestV1Schema, request.body, request.id)
    const service = requireProjectService(projectService, request.id)
    void reply.code(201)
    return projectV1Schema.parse(await service.create(actor, body))
  })

  app.post('/v1/projects/:projectId/lifecycle', async (request) => {
    const actor = await authenticateRequest(
      request.headers,
      request.id,
      request.ip,
      options.config,
      authentication,
    )
    const body = parseBody(projectLifecycleRequestV1Schema, request.body, request.id)
    const path = z.object({ projectId: z.string().uuid() }).safeParse(request.params)
    if (!path.success || path.data.projectId !== body.projectId) {
      throw validationFailed(request.id)
    }
    return projectV1Schema.parse(
      await requireProjectService(projectService, request.id).transition(
        actor,
        body.organizationId,
        body.projectId,
        body.action,
        body.expectedUpdatedAt,
      ),
    )
  })

  app.post('/v1/projects/:projectId/changes', async (request, reply) => {
    const actor = await authenticateRequest(
      request.headers,
      request.id,
      request.ip,
      options.config,
      authentication,
    )
    const body = parseBody(createChangeRequestV1Schema, request.body, request.id)
    requireMatchingProjectPath(request.params, body.projectId, request.id)
    void reply.code(201)
    const result = await requireChangeRequestService(changeRequestService, request.id).create(
      actor,
      body,
    )
    return changeRequirementResultV1Schema.parse({ schemaVersion: '1', ...result })
  })

  app.post('/v1/changes/:changeRequestId/review', async (request) => {
    const actor = await authenticateRequest(
      request.headers,
      request.id,
      request.ip,
      options.config,
      authentication,
    )
    const body = parseBody(requirementReviewRequestV1Schema, request.body, request.id)
    const path = z.object({ changeRequestId: z.string().uuid() }).safeParse(request.params)
    if (!path.success || path.data.changeRequestId !== body.changeRequestId) {
      throw validationFailed(request.id)
    }
    return requirementSpecV1Schema.parse(
      await requireChangeRequestService(changeRequestService, request.id).correct(actor, body),
    )
  })

  app.post('/v1/projects/:projectId/plans', async (request, reply) => {
    const actor = await authenticateRequest(
      request.headers,
      request.id,
      request.ip,
      options.config,
      authentication,
    )
    const body = parseBody(createExecutionPlanRequestV1Schema, request.body, request.id)
    requireMatchingProjectPath(request.params, body.projectId, request.id)
    void reply.code(201)
    return planningResultV1Schema.parse(
      await requirePlanningService(planningService, request.id).create(actor, body),
    )
  })

  app.post('/v1/runs/:runId/approvals/:gate', async (request) => {
    const actor = await authenticateRequest(
      request.headers,
      request.id,
      request.ip,
      options.config,
      authentication,
    )
    const body = parseBody(decideApprovalRequestV1Schema, request.body, request.id)
    const path = z
      .object({ runId: z.string().uuid(), gate: z.string().min(1) })
      .safeParse(request.params)
    if (!path.success || path.data.runId !== body.runId || path.data.gate !== body.gate) {
      throw validationFailed(request.id)
    }
    return approvalDecisionResultV1Schema.parse(
      await requirePlanningService(planningService, request.id).decide(actor, body),
    )
  })

  app.post('/v1/projects/:projectId/repository/github/initiate', async (request, reply) => {
    const actor = await authenticateRequest(
      request.headers,
      request.id,
      request.ip,
      options.config,
      authentication,
    )
    const body = parseBody(githubConnectionInitiationRequestV1Schema, request.body, request.id)
    requireMatchingProjectPath(request.params, body.projectId, request.id)
    void reply.code(201)
    return githubConnectionInitiationResultV1Schema.parse(
      await requireGithubOnboardingService(options.githubOnboardingService, request.id).initiate(
        actor,
        body,
      ),
    )
  })

  app.post('/v1/projects/:projectId/repository/github/complete', async (request) => {
    const actor = await authenticateRequest(
      request.headers,
      request.id,
      request.ip,
      options.config,
      authentication,
    )
    const body = parseBody(githubInstallationSelectionV1Schema, request.body, request.id)
    requireMatchingProjectPath(request.params, body.projectId, request.id)
    return githubRepositoryReadinessV1Schema.parse(
      await requireGithubOnboardingService(options.githubOnboardingService, request.id).complete(
        actor,
        body,
      ),
    )
  })

  app.post('/v1/projects/:projectId/repository/github/refresh', async (request) => {
    const actor = await authenticateRequest(
      request.headers,
      request.id,
      request.ip,
      options.config,
      authentication,
    )
    const body = parseBody(
      z.object({
        schemaVersion: z.literal('1'),
        organizationId: z.string().uuid(),
        projectId: z.string().uuid(),
      }),
      request.body,
      request.id,
    )
    requireMatchingProjectPath(request.params, body.projectId, request.id)
    return githubRepositoryReadinessV1Schema.parse(
      await requireGithubOnboardingService(
        options.githubOnboardingService,
        request.id,
      ).refreshAccess(actor, body.organizationId, body.projectId),
    )
  })

  app.setErrorHandler(async (error, request, reply) => {
    const correlationId = correlationIdSchema.parse(request.id)
    const platformError = isPlatformError(error)
      ? error
      : new PlatformError({
          cause: error,
          code: 'INTERNAL_ERROR',
          correlationId,
          retryable: false,
          safeMessage: 'The request could not be completed safely.',
        })

    if (!isPlatformError(error)) {
      request.log.error({ err: error, correlationId }, 'unhandled request error')
    }

    const statusCode = errorStatusCode(platformError)
    void reply.code(statusCode)
    return apiErrorResponseV1Schema.parse({
      schemaVersion: '1',
      error: {
        code: platformError.code,
        correlationId,
        message: platformError.safeMessage,
        retryable: platformError.retryable,
      },
    })
  })

  app.addHook('onClose', async () => {
    await Promise.all([readinessProbe.close?.(), projectConnection?.close()])
  })

  return app
}

async function authenticateRequest(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  correlationId: string,
  requestIp: string,
  config: ApiConfig,
  authentication: AuthenticationPort,
) {
  return authentication.authenticate(
    extractAuthenticationCredential(headers, correlationId, requestIp, config),
  )
}

function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
  correlationId: string,
): z.infer<T> {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw validationFailed(correlationId)
  return parsed.data
}

function validationFailed(correlationId: string): PlatformError {
  return new PlatformError({
    code: 'VALIDATION_FAILED',
    correlationId: correlationIdSchema.parse(correlationId),
    retryable: false,
    safeMessage: 'The request payload is invalid.',
  })
}

function requireProjectService(
  service: ProjectService | undefined,
  correlationId: string,
): ProjectService {
  if (service !== undefined) return service
  throw new PlatformError({
    code: 'DEPENDENCY_UNAVAILABLE',
    correlationId: correlationIdSchema.parse(correlationId),
    retryable: true,
    safeMessage: 'Project storage is unavailable in this environment.',
  })
}

function requireChangeRequestService(
  service: ChangeRequestService | undefined,
  correlationId: string,
): ChangeRequestService {
  if (service !== undefined) return service
  throw new PlatformError({
    code: 'DEPENDENCY_UNAVAILABLE',
    correlationId: correlationIdSchema.parse(correlationId),
    retryable: true,
    safeMessage: 'Change request processing is not configured.',
  })
}

function requirePlanningService(
  service: PlanningService | undefined,
  correlationId: string,
): PlanningService {
  if (service !== undefined) return service
  throw new PlatformError({
    code: 'DEPENDENCY_UNAVAILABLE',
    correlationId: correlationIdSchema.parse(correlationId),
    retryable: true,
    safeMessage: 'Planning and approval processing is not configured.',
  })
}

function requireGithubOnboardingService(
  service: GithubOnboardingService | undefined,
  correlationId: string,
): GithubOnboardingService {
  if (service !== undefined) return service
  throw new PlatformError({
    code: 'DEPENDENCY_UNAVAILABLE',
    correlationId: correlationIdSchema.parse(correlationId),
    retryable: true,
    safeMessage: 'GitHub App onboarding is not configured in this environment.',
  })
}

function requireMatchingProjectPath(params: unknown, projectId: string, correlationId: string) {
  const path = z.object({ projectId: z.string().uuid() }).safeParse(params)
  if (!path.success || path.data.projectId !== projectId) throw validationFailed(correlationId)
}

function createAuthentication(config: ApiConfig): AuthenticationPort {
  if (config.authMode === 'development' || config.authMode === 'test') {
    return new LocalAuthenticationAdapter(config.authMode)
  }

  if (
    config.authAudience === undefined ||
    config.authIssuer === undefined ||
    config.authJwksUri === undefined
  ) {
    throw new Error('Validated OIDC configuration is incomplete.')
  }

  return new OidcAuthenticationAdapter({
    audience: config.authAudience,
    issuer: config.authIssuer,
    jwksUri: config.authJwksUri,
  })
}

function extractAuthenticationCredential(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  correlationId: string,
  requestIp: string,
  config: ApiConfig,
): AuthenticationCredential {
  const parsedCorrelationId = correlationIdSchema.parse(correlationId)

  if (config.authMode === 'oidc') {
    const authorization = bearerHeaderSchema.safeParse(singleHeader(headers['authorization']))
    if (!authorization.success) throw authenticationRequired(parsedCorrelationId)

    return {
      correlationId: parsedCorrelationId,
      scheme: 'bearer',
      value: authorization.data.replace(/^Bearer\s+/iu, ''),
    }
  }

  if (!config.allowUnsafeLocalAuthRemote && !isLoopbackAddress(requestIp)) {
    throw authenticationRequired(parsedCorrelationId)
  }

  const actorId = singleHeader(headers['x-platform-actor-id'])
  if (actorId === undefined) throw authenticationRequired(parsedCorrelationId)

  return {
    correlationId: parsedCorrelationId,
    scheme: config.authMode,
    value: actorId,
  }
}

function createDatabaseReadinessProbe(config: ApiConfig): ReadinessProbe {
  if (config.databaseUrl === undefined) {
    return {
      name: 'database',
      check() {
        return Promise.resolve({
          checkedAt: new Date().toISOString(),
          detail: 'Explicitly disabled for this environment.',
          name: 'database',
          status: 'disabled',
        })
      },
    }
  }

  const connection = createLazyPostgresConnection({ databaseUrl: config.databaseUrl })

  return {
    name: 'database',
    async check() {
      try {
        await connection.client`SELECT 1 AS ready`
        return {
          checkedAt: new Date().toISOString(),
          name: 'database',
          status: 'healthy',
        }
      } catch {
        return {
          checkedAt: new Date().toISOString(),
          detail: 'Database readiness check failed.',
          name: 'database',
          status: 'unhealthy',
        }
      }
    },
    async close() {
      await connection.close()
    },
  }
}

function authenticationRequired(correlationId: string): PlatformError {
  return new PlatformError({
    code: 'AUTHENTICATION_REQUIRED',
    correlationId: correlationIdSchema.parse(correlationId),
    retryable: false,
    safeMessage: 'Authentication is required for this operation.',
  })
}

function errorStatusCode(error: PlatformError): number {
  const statusByCode = {
    AUTHENTICATION_REQUIRED: 401,
    AUTHORIZATION_DENIED: 403,
    CONFIGURATION_INVALID: 500,
    CONFLICT: 409,
    DEPENDENCY_UNAVAILABLE: 503,
    INTERNAL_ERROR: 500,
    INVALID_TRANSITION: 409,
    NOT_FOUND: 404,
    VALIDATION_FAILED: 400,
  } as const

  return statusByCode[error.code]
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function isLoopbackAddress(value: string): boolean {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}
