import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Identifiers intentionally have no database defaults. The application must
 * create UUIDs before persistence so one identifier follows an operation
 * across API, workflow, audit, and provider boundaries.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    identityProviderId: text('identity_provider_id').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('users_identity_provider_id_unique').on(table.identityProviderId),
    check('users_status_check', sql`${table.status} in ('active', 'suspended', 'disabled')`),
  ],
)

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    policyProfileId: uuid('policy_profile_id'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('organizations_slug_unique').on(table.slug),
    check(
      'organizations_status_check',
      sql`${table.status} in ('active', 'suspended', 'archived')`,
    ),
  ],
)

export const memberships = pgTable(
  'memberships',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.userId],
      name: 'memberships_organization_id_user_id_pk',
    }),
    index('memberships_user_id_idx').on(table.userId),
    check(
      'memberships_role_check',
      sql`${table.role} in ('owner', 'developer', 'designer', 'reviewer', 'viewer')`,
    ),
    check('memberships_status_check', sql`${table.status} in ('active', 'suspended', 'revoked')`),
  ],
)

export const policyProfiles = pgTable(
  'policy_profiles',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    name: text('name').notNull(),
    deletionRetentionDays: integer('deletion_retention_days').notNull().default(30),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('policy_profiles_organization_id_id_unique').on(table.organizationId, table.id),
    unique('policy_profiles_organization_id_name_unique').on(table.organizationId, table.name),
    check(
      'policy_profiles_retention_days_check',
      sql`${table.deletionRetentionDays} BETWEEN 0 AND 3650`,
    ),
    check('policy_profiles_status_check', sql`${table.status} in ('active', 'retired')`),
  ],
)

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: text('status').notNull().default('active'),
    pluginType: text('plugin_type').notNull().default('website'),
    policyId: uuid('policy_id'),
    archivedAt: timestamp('archived_at', { mode: 'date', withTimezone: true }),
    deletionRequestedAt: timestamp('deletion_requested_at', { mode: 'date', withTimezone: true }),
    retentionUntil: timestamp('retention_until', { mode: 'date', withTimezone: true }),
    deletedAt: timestamp('deleted_at', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('projects_organization_id_slug_unique').on(table.organizationId, table.slug),
    unique('projects_organization_id_id_unique').on(table.organizationId, table.id),
    index('projects_organization_id_status_idx').on(table.organizationId, table.status),
    check(
      'projects_status_check',
      sql`${table.status} in ('active', 'archived', 'deletion_pending', 'deleted')`,
    ),
    foreignKey({
      columns: [table.organizationId, table.policyId],
      foreignColumns: [policyProfiles.organizationId, policyProfiles.id],
      name: 'projects_policy_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
  ],
)

export const serviceIdentities = pgTable(
  'service_identities',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    projectId: uuid('project_id'),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('service_identities_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: 'service_identities_project_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'service_identities_status_check',
      sql`${table.status} in ('active', 'suspended', 'revoked')`,
    ),
  ],
)

export const serviceIdentityPermissions = pgTable(
  'service_identity_permissions',
  {
    organizationId: uuid('organization_id').notNull(),
    serviceIdentityId: uuid('service_identity_id').notNull(),
    permission: text('permission').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.serviceIdentityId, table.permission],
      name: 'service_identity_permissions_pk',
    }),
    foreignKey({
      columns: [table.organizationId, table.serviceIdentityId],
      foreignColumns: [serviceIdentities.organizationId, serviceIdentities.id],
      name: 'service_identity_permissions_identity_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'service_identity_permissions_permission_check',
      sql`${table.permission} in (
      'project:read', 'project:create', 'project:archive', 'project:restore', 'project:delete',
      'change:request', 'change:approve', 'repository:connect', 'git:merge', 'release:promote', 'secret:manage',
      'policy:modify', 'member:manage'
    )`,
    ),
  ],
)

export const githubConnectionAttempts = pgTable(
  'github_connection_attempts',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    stateDigest: text('state_digest').notNull(),
    returnUrl: text('return_url').notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: 'github_connection_attempts_project_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('github_connection_attempts_project_id_idx').on(table.projectId, table.expiresAt),
    check('github_connection_attempts_state_digest_check', sql`length(${table.stateDigest}) = 64`),
  ],
)

export const repositoryConnections = pgTable(
  'repository_connections',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    provider: text('provider').notNull(),
    installationId: text('installation_id').notNull(),
    repositoryId: text('repository_id').notNull(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    permissions: jsonb('permissions').notNull(),
    defaultBranch: text('default_branch').notNull(),
    indexedCommit: text('indexed_commit').notNull(),
    appCredentialRef: jsonb('app_credential_ref').notNull(),
    readiness: text('readiness').notNull(),
    mutationEnabled: boolean('mutation_enabled').notNull().default(false),
    metadata: jsonb('metadata').notNull(),
    connectedAt: timestamp('connected_at', { mode: 'date', withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    unique('repository_connections_organization_project_unique').on(
      table.organizationId,
      table.projectId,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: 'repository_connections_project_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('repository_connections_provider_check', sql`${table.provider} = 'github'`),
    check(
      'repository_connections_readiness_check',
      sql`${table.readiness} in ('ready', 'insufficient_permissions', 'access_lost')`,
    ),
    check('repository_connections_mutation_disabled_check', sql`${table.mutationEnabled} = false`),
    check('repository_connections_commit_check', sql`length(${table.indexedCommit}) = 40`),
    check(
      'repository_connections_secret_reference_check',
      sql`jsonb_typeof(${table.appCredentialRef}) = 'object'
        AND ${table.appCredentialRef} ? 'provider'
        AND ${table.appCredentialRef} ? 'key'
        AND NOT (${table.appCredentialRef} ?| array['value', 'token', 'secret', 'privateKey'])`,
    ),
  ],
)

export const changeRequests = pgTable(
  'change_requests',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    actorType: text('actor_type').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    originalPrompt: text('original_prompt').notNull(),
    mode: text('mode').notNull(),
    target: text('target').notNull(),
    constraints: jsonb('constraints').notNull(),
    attachments: jsonb('attachments').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    unique('change_requests_organization_project_id_unique').on(
      table.organizationId,
      table.projectId,
      table.id,
    ),
    unique('change_requests_organization_project_idempotency_unique').on(
      table.organizationId,
      table.projectId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: 'change_requests_project_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('change_requests_project_created_at_idx').on(table.projectId, table.createdAt),
    check('change_requests_actor_type_check', sql`${table.actorType} in ('user', 'service')`),
    check(
      'change_requests_mode_check',
      sql`${table.mode} in ('builder', 'designer', 'refactor', 'debug', 'seo', 'performance', 'accessibility', 'content')`,
    ),
    check(
      'change_requests_target_check',
      sql`${table.target} in ('preview', 'staging', 'production')`,
    ),
    check(
      'change_requests_status_check',
      sql`${table.status} in ('intake_complete', 'requirements_pending', 'requirements_review', 'blocked')`,
    ),
    check('change_requests_prompt_check', sql`length(${table.originalPrompt}) between 1 and 20000`),
    check(
      'change_requests_json_shape_check',
      sql`jsonb_typeof(${table.constraints}) = 'array' AND jsonb_typeof(${table.attachments}) = 'array'`,
    ),
  ],
)

export const requirementSpecs = pgTable(
  'requirement_specs',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    changeRequestId: uuid('change_request_id').notNull(),
    schemaVersion: text('schema_version').notNull(),
    revision: integer('revision').notNull(),
    body: jsonb('body').notNull(),
    assumptions: jsonb('assumptions').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    unique('requirement_specs_change_request_revision_unique').on(
      table.changeRequestId,
      table.revision,
    ),
    unique('requirement_specs_organization_project_change_id_unique').on(
      table.organizationId,
      table.projectId,
      table.changeRequestId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.changeRequestId],
      foreignColumns: [changeRequests.organizationId, changeRequests.projectId, changeRequests.id],
      name: 'requirement_specs_change_request_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('requirement_specs_change_request_revision_idx').on(
      table.changeRequestId,
      table.revision,
    ),
    check('requirement_specs_schema_version_check', sql`${table.schemaVersion} = '1'`),
    check('requirement_specs_revision_check', sql`${table.revision} > 0`),
    check(
      'requirement_specs_json_shape_check',
      sql`jsonb_typeof(${table.body}) = 'object' AND jsonb_typeof(${table.assumptions}) = 'array'`,
    ),
  ],
)

export const executionPlans = pgTable(
  'execution_plans',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    changeRequestId: uuid('change_request_id').notNull(),
    requirementId: uuid('requirement_id').notNull(),
    idempotencyKey: text('idempotency_key'),
    schemaVersion: text('schema_version').notNull(),
    revision: integer('revision').notNull(),
    baseCommit: text('base_commit').notNull(),
    riskClass: text('risk_class').notNull(),
    body: jsonb('body').notNull(),
    policySnapshot: jsonb('policy_snapshot').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    unique('execution_plans_organization_project_change_id_unique').on(
      table.organizationId,
      table.projectId,
      table.changeRequestId,
      table.id,
    ),
    unique('execution_plans_organization_project_id_unique').on(
      table.organizationId,
      table.projectId,
      table.id,
    ),
    unique('execution_plans_change_revision_unique').on(table.changeRequestId, table.revision),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.changeRequestId, table.requirementId],
      foreignColumns: [
        requirementSpecs.organizationId,
        requirementSpecs.projectId,
        requirementSpecs.changeRequestId,
        requirementSpecs.id,
      ],
      name: 'execution_plans_requirement_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('execution_plans_change_revision_idx').on(table.changeRequestId, table.revision),
    uniqueIndex('execution_plans_tenant_idempotency_unique')
      .on(table.organizationId, table.projectId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    check('execution_plans_schema_version_check', sql`${table.schemaVersion} = '1'`),
    check('execution_plans_revision_check', sql`${table.revision} > 0`),
    check('execution_plans_base_commit_check', sql`${table.baseCommit} ~ '^[0-9a-f]{40}$'`),
    check(
      'execution_plans_risk_class_check',
      sql`${table.riskClass} in ('low', 'medium', 'high', 'blocked')`,
    ),
    check(
      'execution_plans_json_shape_check',
      sql`jsonb_typeof(${table.body}) = 'object' AND jsonb_typeof(${table.policySnapshot}) = 'object'`,
    ),
  ],
)

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    changeRequestId: uuid('change_request_id').notNull(),
    executionPlanId: uuid('execution_plan_id').notNull(),
    baseCommit: text('base_commit').notNull(),
    state: text('state').notNull(),
    policySnapshot: jsonb('policy_snapshot').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { mode: 'date', withTimezone: true }),
    endedAt: timestamp('ended_at', { mode: 'date', withTimezone: true }),
  },
  (table) => [
    unique('runs_organization_project_id_unique').on(
      table.organizationId,
      table.projectId,
      table.id,
    ),
    unique('runs_tenant_id_plan_unique').on(
      table.organizationId,
      table.projectId,
      table.id,
      table.executionPlanId,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.changeRequestId],
      foreignColumns: [changeRequests.organizationId, changeRequests.projectId, changeRequests.id],
      name: 'runs_change_request_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [
        table.organizationId,
        table.projectId,
        table.changeRequestId,
        table.executionPlanId,
      ],
      foreignColumns: [
        executionPlans.organizationId,
        executionPlans.projectId,
        executionPlans.changeRequestId,
        executionPlans.id,
      ],
      name: 'runs_execution_plan_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('runs_project_created_at_idx').on(table.projectId, table.createdAt),
    check('runs_base_commit_check', sql`${table.baseCommit} ~ '^[0-9a-f]{40}$'`),
    check(
      'runs_state_check',
      sql`${table.state} in ('DRAFT', 'PLANNING', 'AWAITING_APPROVAL', 'QUEUED', 'PREPARING', 'IMPLEMENTING', 'VALIDATING', 'COMMITTING', 'DEPLOYING_PREVIEW', 'VERIFYING_PREVIEW', 'READY_FOR_REVIEW', 'PROMOTING', 'COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED', 'ROLLED_BACK')`,
    ),
    check('runs_policy_snapshot_check', sql`jsonb_typeof(${table.policySnapshot}) = 'object'`),
  ],
)

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    runId: uuid('run_id').notNull(),
    planId: uuid('plan_id').notNull(),
    planRevision: integer('plan_revision').notNull(),
    gate: text('gate').notNull(),
    decision: text('decision').notNull(),
    requesterId: uuid('requester_id').notNull(),
    approverId: uuid('approver_id'),
    rationale: text('rationale'),
    policyVersion: text('policy_version').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestedAt: timestamp('requested_at', { mode: 'date', withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { mode: 'date', withTimezone: true }),
  },
  (table) => [
    unique('approvals_run_gate_unique').on(table.runId, table.gate),
    unique('approvals_tenant_idempotency_unique').on(
      table.organizationId,
      table.projectId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.runId],
      foreignColumns: [runs.organizationId, runs.projectId, runs.id],
      name: 'approvals_run_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.planId],
      foreignColumns: [executionPlans.organizationId, executionPlans.projectId, executionPlans.id],
      name: 'approvals_plan_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('approvals_plan_revision_check', sql`${table.planRevision} > 0`),
    check(
      'approvals_gate_check',
      sql`${table.gate} in ('plan_execution', 'destructive_action', 'production_promotion')`,
    ),
    check(
      'approvals_decision_check',
      sql`${table.decision} in ('pending', 'approved', 'rejected')`,
    ),
    check(
      'approvals_decision_shape_check',
      sql`(${table.decision} = 'pending' AND ${table.approverId} IS NULL AND ${table.rationale} IS NULL AND ${table.decidedAt} IS NULL) OR (${table.decision} in ('approved', 'rejected') AND ${table.approverId} IS NOT NULL AND ${table.rationale} IS NOT NULL AND ${table.decidedAt} IS NOT NULL)`,
    ),
  ],
)

export const runnerWorkspaces = pgTable(
  'runner_workspaces',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    runId: uuid('run_id').notNull(),
    executionPlanId: uuid('execution_plan_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestDigest: text('request_digest').notNull(),
    baseCommit: text('base_commit').notNull(),
    profileDigest: text('profile_digest').notNull(),
    backendClass: text('backend_class').notNull(),
    profile: jsonb('profile').notNull(),
    checkoutEvidence: jsonb('checkout_evidence').notNull(),
    state: text('state').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    unique('runner_workspaces_organization_project_id_unique').on(
      table.organizationId,
      table.projectId,
      table.id,
    ),
    unique('runner_workspaces_tenant_run_unique').on(
      table.organizationId,
      table.projectId,
      table.runId,
    ),
    unique('runner_workspaces_tenant_idempotency_unique').on(
      table.organizationId,
      table.projectId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.runId, table.executionPlanId],
      foreignColumns: [runs.organizationId, runs.projectId, runs.id, runs.executionPlanId],
      name: 'runner_workspaces_run_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.executionPlanId],
      foreignColumns: [executionPlans.organizationId, executionPlans.projectId, executionPlans.id],
      name: 'runner_workspaces_plan_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('runner_workspaces_request_digest_check', sql`length(${table.requestDigest}) = 64`),
    check(
      'runner_workspaces_idempotency_key_check',
      sql`length(${table.idempotencyKey}) between 8 and 256`,
    ),
    check('runner_workspaces_base_commit_check', sql`length(${table.baseCommit}) = 40`),
    check('runner_workspaces_profile_digest_check', sql`length(${table.profileDigest}) = 64`),
    check(
      'runner_workspaces_backend_class_check',
      sql`${table.backendClass} in ('conformance_fixture', 'production_isolation')`,
    ),
    check(
      'runner_workspaces_state_check',
      sql`${table.state} in ('ready', 'cancelled', 'destroyed')`,
    ),
    check('runner_workspaces_profile_check', sql`jsonb_typeof(${table.profile}) = 'object'`),
    check(
      'runner_workspaces_checkout_evidence_check',
      sql`jsonb_typeof(${table.checkoutEvidence}) = 'object'`,
    ),
  ],
)

export const runnerCommands = pgTable(
  'runner_commands',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    runId: uuid('run_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestDigest: text('request_digest').notNull(),
    baseCommit: text('base_commit').notNull(),
    profileDigest: text('profile_digest').notNull(),
    tool: text('tool').notNull(),
    executable: text('executable').notNull(),
    workingDirectory: text('working_directory').notNull(),
    timeoutMs: integer('timeout_ms').notNull(),
    executionKind: text('execution_kind').notNull(),
    status: text('status').notNull(),
    exitCode: integer('exit_code'),
    rejectionCode: text('rejection_code'),
    stdoutRef: jsonb('stdout_ref'),
    stderrRef: jsonb('stderr_ref'),
    startedAt: timestamp('started_at', { mode: 'date', withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    unique('runner_commands_organization_project_id_unique').on(
      table.organizationId,
      table.projectId,
      table.id,
    ),
    unique('runner_commands_tenant_idempotency_unique').on(
      table.organizationId,
      table.projectId,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.workspaceId],
      foreignColumns: [
        runnerWorkspaces.organizationId,
        runnerWorkspaces.projectId,
        runnerWorkspaces.id,
      ],
      name: 'runner_commands_workspace_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.runId],
      foreignColumns: [runs.organizationId, runs.projectId, runs.id],
      name: 'runner_commands_run_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('runner_commands_request_digest_check', sql`length(${table.requestDigest}) = 64`),
    check(
      'runner_commands_idempotency_key_check',
      sql`length(${table.idempotencyKey}) between 8 and 256`,
    ),
    check('runner_commands_base_commit_check', sql`length(${table.baseCommit}) = 40`),
    check('runner_commands_profile_digest_check', sql`length(${table.profileDigest}) = 64`),
    check('runner_commands_timeout_check', sql`${table.timeoutMs} between 100 and 3600000`),
    check(
      'runner_commands_execution_kind_check',
      sql`${table.executionKind} in ('simulated_conformance', 'isolated_runtime')`,
    ),
    check(
      'runner_commands_status_check',
      sql`${table.status} in ('succeeded', 'failed', 'cancelled', 'rejected')`,
    ),
  ],
)

export const runnerArtifacts = pgTable(
  'runner_artifacts',
  {
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    runId: uuid('run_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    commandId: uuid('command_id').notNull(),
    path: text('path').notNull(),
    reference: jsonb('reference').notNull(),
    digest: text('digest').notNull(),
    mediaType: text('media_type').notNull(),
    retentionClass: text('retention_class').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.projectId, table.commandId, table.path],
      name: 'runner_artifacts_pk',
    }),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.commandId],
      foreignColumns: [runnerCommands.organizationId, runnerCommands.projectId, runnerCommands.id],
      name: 'runner_artifacts_command_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.workspaceId],
      foreignColumns: [
        runnerWorkspaces.organizationId,
        runnerWorkspaces.projectId,
        runnerWorkspaces.id,
      ],
      name: 'runner_artifacts_workspace_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.runId],
      foreignColumns: [runs.organizationId, runs.projectId, runs.id],
      name: 'runner_artifacts_run_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'runner_artifacts_reference_check',
      sql`jsonb_typeof(${table.reference}) = 'object'
        AND ${table.reference}->>'digest' = ${table.digest}
        AND ${table.reference}->>'mediaType' = ${table.mediaType}
        AND ${table.reference}->>'retentionClass' = ${table.retentionClass}`,
    ),
    check('runner_artifacts_digest_check', sql`length(${table.digest}) = 64`),
    check('runner_artifacts_size_check', sql`${table.sizeBytes} >= 0`),
  ],
)

export const protectedArtifacts = pgTable(
  'protected_artifacts',
  {
    artifactId: uuid('artifact_id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    runId: uuid('run_id').notNull(),
    blobPath: text('blob_path').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    mediaType: text('media_type').notNull(),
    retentionClass: text('retention_class').notNull(),
    deleteAfter: timestamp('delete_after', { mode: 'date', withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { mode: 'date', withTimezone: true }),
  },
  (table) => [
    unique('protected_artifacts_tenant_id_unique').on(
      table.organizationId,
      table.projectId,
      table.artifactId,
    ),
    unique('protected_artifacts_blob_path_unique').on(table.blobPath),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.runId],
      foreignColumns: [runs.organizationId, runs.projectId, runs.id],
      name: 'protected_artifacts_run_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('protected_artifacts_gc_idx').on(table.deleteAfter),
    check('protected_artifacts_sha256_check', sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
    check('protected_artifacts_size_check', sql`${table.sizeBytes} between 0 and 16777216`),
    check(
      'protected_artifacts_retention_check',
      sql`${table.retentionClass} in ('ephemeral', 'benchmark', 'standard', 'pinned') AND ((${table.retentionClass} = 'pinned') = (${table.deleteAfter} IS NULL))`,
    ),
  ],
)

export const runnerLifecycleRecords = pgTable(
  'runner_lifecycle_records',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    runId: uuid('run_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    action: text('action').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestDigest: text('request_digest').notNull(),
    resultStatus: text('result_status').notNull(),
    occurredAt: timestamp('occurred_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    unique('runner_lifecycle_tenant_action_idempotency_unique').on(
      table.organizationId,
      table.projectId,
      table.action,
      table.idempotencyKey,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.workspaceId],
      foreignColumns: [
        runnerWorkspaces.organizationId,
        runnerWorkspaces.projectId,
        runnerWorkspaces.id,
      ],
      name: 'runner_lifecycle_workspace_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.runId],
      foreignColumns: [runs.organizationId, runs.projectId, runs.id],
      name: 'runner_lifecycle_run_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('runner_lifecycle_action_check', sql`${table.action} in ('cancel', 'cleanup')`),
    check('runner_lifecycle_request_digest_check', sql`length(${table.requestDigest}) = 64`),
    check(
      'runner_lifecycle_idempotency_key_check',
      sql`length(${table.idempotencyKey}) between 8 and 256`,
    ),
    check(
      'runner_lifecycle_result_status_check',
      sql`${table.resultStatus} in ('cancelled', 'already_cancelled', 'destroyed', 'already_destroyed')`,
    ),
  ],
)

export const runnerProviderSessions = pgTable(
  'runner_provider_sessions',
  {
    provisionKey: text('provision_key').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    runId: uuid('run_id').notNull(),
    executionPlanId: uuid('execution_plan_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    provider: text('provider').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    identityDigest: text('identity_digest').notNull(),
    plan: jsonb('plan').notNull(),
    profile: jsonb('profile').notNull(),
    workspace: jsonb('workspace').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('runner_provider_sessions_tenant_provision_unique').on(
      table.organizationId,
      table.projectId,
      table.provisionKey,
    ),
    unique('runner_provider_sessions_tenant_workspace_unique').on(
      table.organizationId,
      table.projectId,
      table.workspaceId,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.runId, table.executionPlanId],
      foreignColumns: [runs.organizationId, runs.projectId, runs.id, runs.executionPlanId],
      name: 'runner_provider_sessions_run_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('runner_provider_sessions_provision_key_check', sql`length(${table.provisionKey}) = 64`),
    check(
      'runner_provider_sessions_request_fingerprint_check',
      sql`length(${table.requestFingerprint}) = 64`,
    ),
    check(
      'runner_provider_sessions_identity_digest_check',
      sql`length(${table.identityDigest}) = 64`,
    ),
    check('runner_provider_sessions_provider_check', sql`${table.provider} = 'vercel_sandbox'`),
    check('runner_provider_sessions_plan_check', sql`jsonb_typeof(${table.plan}) = 'object'`),
    check('runner_provider_sessions_profile_check', sql`jsonb_typeof(${table.profile}) = 'object'`),
    check(
      'runner_provider_sessions_workspace_check',
      sql`jsonb_typeof(${table.workspace}) = 'object'`,
    ),
  ],
)

export const runnerProviderCommandReplays = pgTable(
  'runner_provider_command_replays',
  {
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    provisionKey: text('provision_key').notNull(),
    commandId: uuid('command_id').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    result: jsonb('result').notNull(),
    completedAt: timestamp('completed_at', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.projectId, table.commandId],
      name: 'runner_provider_command_replays_pk',
    }),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.provisionKey],
      foreignColumns: [
        runnerProviderSessions.organizationId,
        runnerProviderSessions.projectId,
        runnerProviderSessions.provisionKey,
      ],
      name: 'runner_provider_command_replays_session_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'runner_provider_command_replays_fingerprint_check',
      sql`length(${table.requestFingerprint}) = 64`,
    ),
    check(
      'runner_provider_command_replays_result_check',
      sql`jsonb_typeof(${table.result}) = 'object'`,
    ),
  ],
)

export const workerDispatches = pgTable(
  'worker_dispatches',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    actorRef: text('actor_ref').notNull(),
    correlationId: uuid('correlation_id').notNull(),
    requestedAt: timestamp('requested_at', { mode: 'date', withTimezone: true }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestDigest: text('request_digest').notNull(),
    commandRef: jsonb('command_ref').notNull(),
    status: text('status').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    availableAt: timestamp('available_at', { mode: 'date', withTimezone: true }).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { mode: 'date', withTimezone: true }),
    lastFailureCode: text('last_failure_code'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { mode: 'date', withTimezone: true }),
  },
  (table) => [
    unique('worker_dispatches_tenant_idempotency_unique').on(
      table.organizationId,
      table.projectId,
      table.idempotencyKey,
    ),
    unique('worker_dispatches_tenant_id_unique').on(
      table.organizationId,
      table.projectId,
      table.id,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: 'worker_dispatches_project_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('worker_dispatches_claim_idx').on(table.status, table.availableAt),
    check('worker_dispatches_request_digest_check', sql`length(${table.requestDigest}) = 64`),
    check(
      'worker_dispatches_actor_ref_check',
      sql`${table.actorRef} ~ '^(user|service):[0-9a-f-]{36}$'`,
    ),
    check(
      'worker_dispatches_idempotency_key_check',
      sql`length(${table.idempotencyKey}) between 8 and 256`,
    ),
    check('worker_dispatches_command_ref_check', sql`jsonb_typeof(${table.commandRef}) = 'object'`),
    check(
      'worker_dispatches_status_check',
      sql`${table.status} in ('queued', 'running', 'retry_wait', 'succeeded', 'failed')`,
    ),
    check(
      'worker_dispatches_attempts_check',
      sql`${table.attemptCount} between 0 and ${table.maxAttempts} AND ${table.maxAttempts} between 1 and 10`,
    ),
    check(
      'worker_dispatches_lease_shape_check',
      sql`(${table.status} = 'running' AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      'worker_dispatches_completion_shape_check',
      sql`(${table.status} in ('succeeded', 'failed')) = (${table.completedAt} IS NOT NULL)`,
    ),
  ],
)

export const workerDispatchAttempts = pgTable(
  'worker_dispatch_attempts',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    dispatchId: uuid('dispatch_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    workerId: text('worker_id').notNull(),
    outcome: text('outcome').notNull(),
    failureCode: text('failure_code'),
    startedAt: timestamp('started_at', { mode: 'date', withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { mode: 'date', withTimezone: true }).notNull(),
    nextAvailableAt: timestamp('next_available_at', { mode: 'date', withTimezone: true }),
  },
  (table) => [
    unique('worker_dispatch_attempts_dispatch_number_unique').on(
      table.organizationId,
      table.projectId,
      table.dispatchId,
      table.attemptNumber,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId, table.dispatchId],
      foreignColumns: [
        workerDispatches.organizationId,
        workerDispatches.projectId,
        workerDispatches.id,
      ],
      name: 'worker_dispatch_attempts_dispatch_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('worker_dispatch_attempts_number_check', sql`${table.attemptNumber} between 1 and 10`),
    check(
      'worker_dispatch_attempts_outcome_check',
      sql`${table.outcome} in ('succeeded', 'retry_scheduled', 'failed', 'lease_expired')`,
    ),
  ],
)

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    schemaVersion: text('schema_version').notNull().default('1'),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, {
        onDelete: 'restrict',
        onUpdate: 'restrict',
      }),
    projectId: uuid('project_id'),
    actorRef: text('actor_ref').notNull(),
    action: text('action').notNull(),
    targetRef: text('target_ref').notNull(),
    outcome: text('outcome').notNull(),
    correlationId: uuid('correlation_id').notNull(),
    payloadRef: text('payload_ref'),
    occurredAt: timestamp('occurred_at', {
      mode: 'date',
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.organizationId, projects.id],
      name: 'audit_events_project_tenant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('audit_events_organization_id_occurred_at_idx').on(
      table.organizationId,
      table.occurredAt,
    ),
    index('audit_events_project_id_occurred_at_idx').on(table.projectId, table.occurredAt),
    index('audit_events_correlation_id_idx').on(table.correlationId),
  ],
)

export type UserRow = typeof users.$inferSelect
export type NewUserRow = typeof users.$inferInsert
export type OrganizationRow = typeof organizations.$inferSelect
export type NewOrganizationRow = typeof organizations.$inferInsert
export type MembershipRow = typeof memberships.$inferSelect
export type NewMembershipRow = typeof memberships.$inferInsert
export type ProjectRow = typeof projects.$inferSelect
export type NewProjectRow = typeof projects.$inferInsert
export type AuditEventRow = typeof auditEvents.$inferSelect
export type NewAuditEventRow = typeof auditEvents.$inferInsert
export type PolicyProfileRow = typeof policyProfiles.$inferSelect
export type ServiceIdentityRow = typeof serviceIdentities.$inferSelect
export type ServiceIdentityPermissionRow = typeof serviceIdentityPermissions.$inferSelect
export type GithubConnectionAttemptRow = typeof githubConnectionAttempts.$inferSelect
export type RepositoryConnectionRow = typeof repositoryConnections.$inferSelect
export type ChangeRequestRow = typeof changeRequests.$inferSelect
export type RequirementSpecRow = typeof requirementSpecs.$inferSelect
export type ExecutionPlanRow = typeof executionPlans.$inferSelect
export type RunRow = typeof runs.$inferSelect
export type ApprovalRow = typeof approvals.$inferSelect
export type RunnerWorkspaceRow = typeof runnerWorkspaces.$inferSelect
export type RunnerCommandRow = typeof runnerCommands.$inferSelect
export type RunnerArtifactRow = typeof runnerArtifacts.$inferSelect
export type ProtectedArtifactRow = typeof protectedArtifacts.$inferSelect
export type RunnerLifecycleRecordRow = typeof runnerLifecycleRecords.$inferSelect
export type RunnerProviderSessionRow = typeof runnerProviderSessions.$inferSelect
export type RunnerProviderCommandReplayRow = typeof runnerProviderCommandReplays.$inferSelect
export type WorkerDispatchRow = typeof workerDispatches.$inferSelect
export type WorkerDispatchAttemptRow = typeof workerDispatchAttempts.$inferSelect
