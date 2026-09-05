import { z } from 'zod'

import {
  correlationIdSchema,
  isoTimestampSchema,
  opaqueIdSchema,
  schemaVersionV1,
} from './common.js'

export const organizationRoleV1Schema = z.enum([
  'owner',
  'developer',
  'designer',
  'reviewer',
  'viewer',
])

export const projectPermissionV1Schema = z.enum([
  'project:read',
  'project:create',
  'project:archive',
  'project:restore',
  'project:delete',
  'change:request',
  'change:approve',
  'run:execute',
  'repository:connect',
  'git:merge',
  'release:promote',
  'secret:manage',
  'policy:modify',
  'member:manage',
])

export const projectStatusV1Schema = z.enum(['active', 'archived', 'deletion_pending', 'deleted'])

export const projectV1Schema = z.object({
  schemaVersion: schemaVersionV1,
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  name: z.string().trim().min(1).max(160),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    .max(80),
  pluginType: z.literal('website'),
  policyId: opaqueIdSchema,
  status: projectStatusV1Schema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.optional(),
  deletionRequestedAt: isoTimestampSchema.optional(),
  retentionUntil: isoTimestampSchema.optional(),
  deletedAt: isoTimestampSchema.optional(),
})

export const createProjectRequestV1Schema = z.object({
  schemaVersion: schemaVersionV1,
  organizationId: opaqueIdSchema,
  name: z.string().trim().min(1).max(160),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    .max(80),
  policyId: opaqueIdSchema,
})

export const projectLifecycleActionV1Schema = z.enum(['archive', 'restore', 'delete'])

export const projectLifecycleRequestV1Schema = z.object({
  schemaVersion: schemaVersionV1,
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  action: projectLifecycleActionV1Schema,
  expectedUpdatedAt: isoTimestampSchema.optional(),
})

export const authorizationDecisionV1Schema = z.object({
  schemaVersion: schemaVersionV1,
  allowed: z.boolean(),
  actorId: opaqueIdSchema,
  actorType: z.enum(['user', 'service']),
  organizationId: opaqueIdSchema,
  projectId: opaqueIdSchema.optional(),
  permission: projectPermissionV1Schema,
  correlationId: correlationIdSchema,
  reason: z.enum([
    'allowed',
    'membership_missing',
    'membership_inactive',
    'permission_missing',
    'tenant_mismatch',
  ]),
  decidedAt: isoTimestampSchema,
})

export type AuthorizationDecisionV1 = z.infer<typeof authorizationDecisionV1Schema>
export type CreateProjectRequestV1 = z.infer<typeof createProjectRequestV1Schema>
export type OrganizationRoleV1 = z.infer<typeof organizationRoleV1Schema>
export type ProjectLifecycleActionV1 = z.infer<typeof projectLifecycleActionV1Schema>
export type ProjectLifecycleRequestV1 = z.infer<typeof projectLifecycleRequestV1Schema>
export type ProjectPermissionV1 = z.infer<typeof projectPermissionV1Schema>
export type ProjectStatusV1 = z.infer<typeof projectStatusV1Schema>
export type ProjectV1 = z.infer<typeof projectV1Schema>
