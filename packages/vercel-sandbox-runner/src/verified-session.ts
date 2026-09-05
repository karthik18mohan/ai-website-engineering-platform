import { PlatformError } from '@platform/domain'

import type { VercelSandboxFactory, VercelSandboxHandle } from './sdk-client.js'
import type { VercelSandboxWorkspacePlan } from './workspace-plan.js'

export async function createVerifiedVercelSandboxSession(
  plan: VercelSandboxWorkspacePlan,
  factory: VercelSandboxFactory,
): Promise<VercelSandboxHandle> {
  const handle = await factory.create(plan.create)
  return verifyVercelSandboxSession(handle, plan)
}

export async function verifyVercelSandboxSession(
  handle: VercelSandboxHandle,
  plan: VercelSandboxWorkspacePlan,
): Promise<VercelSandboxHandle> {
  const matches =
    handle.name === plan.create.name &&
    handle.image === plan.expected.image &&
    handle.vcpus === plan.expected.vcpus &&
    handle.memory === plan.expected.memoryMiB &&
    handle.timeout === plan.create.timeout &&
    handle.persistent === plan.expected.persistent &&
    handle.status === 'running' &&
    handle.expiresAt !== undefined &&
    JSON.stringify(handle.networkPolicy) === JSON.stringify(plan.expected.networkPolicy) &&
    JSON.stringify(handle.tags) === JSON.stringify(plan.create.tags)

  if (matches) return handle

  try {
    await handle.stop()
  } catch {
    // Preserve the validation failure; provider cleanup is best-effort here.
  }
  throw new PlatformError({
    code: 'VALIDATION_FAILED',
    correlationId: plan.correlationId,
    retryable: false,
    safeMessage: 'The provisioned sandbox does not match the authorized workspace plan.',
  })
}
