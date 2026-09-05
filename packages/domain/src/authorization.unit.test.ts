import type { ActorContextV1, OrganizationRoleV1, ProjectPermissionV1 } from '@platform/contracts'
import { describe, expect, it } from 'vitest'
import { authorize } from './authorization.js'

const actor: ActorContextV1 = {
  schemaVersion: '1',
  actorId: '00000000-0000-4000-8000-000000000001',
  actorType: 'user',
  authenticationMethod: 'test',
  correlationId: '00000000-0000-4000-8000-000000000002',
  issuedAt: '2026-08-11T00:00:00.000Z',
  organizationId: '00000000-0000-4000-8000-000000000003',
  sessionId: '00000000-0000-4000-8000-000000000004',
  subject: 'test:user',
}

const cases: readonly [OrganizationRoleV1, ProjectPermissionV1, boolean][] = [
  ['owner', 'policy:modify', true],
  ['developer', 'change:request', true],
  ['developer', 'git:merge', false],
  ['designer', 'change:request', true],
  ['designer', 'git:merge', false],
  ['reviewer', 'change:approve', true],
  ['reviewer', 'secret:manage', false],
  ['owner', 'repository:connect', true],
  ['owner', 'run:execute', false],
  ['viewer', 'project:read', true],
  ['viewer', 'repository:connect', false],
  ['viewer', 'change:request', false],
]

describe('M02 authorization policy', () => {
  it.each(cases)('%s / %s allowed=%s', (role, permission, allowed) => {
    expect(
      authorize({
        actor,
        correlationId: actor.correlationId,
        decidedAt: new Date(),
        membership: {
          actorId: actor.actorId,
          organizationId: actor.organizationId!,
          role,
          status: 'active',
        },
        organizationId: actor.organizationId!,
        permission,
      }).allowed,
    ).toBe(allowed)
  })

  it('rejects stale membership and cross-tenant access', () => {
    expect(
      authorize({
        actor,
        correlationId: actor.correlationId,
        decidedAt: new Date(),
        membership: {
          actorId: actor.actorId,
          organizationId: actor.organizationId!,
          role: 'owner',
          status: 'revoked',
        },
        organizationId: actor.organizationId!,
        permission: 'project:create',
      }).reason,
    ).toBe('membership_inactive')
    expect(
      authorize({
        actor,
        correlationId: actor.correlationId,
        decidedAt: new Date(),
        organizationId: '00000000-0000-4000-8000-000000000099',
        permission: 'project:create',
      }).reason,
    ).toBe('tenant_mismatch')
  })
})
