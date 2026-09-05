import { createHash } from 'node:crypto'

import type { ProviderRequestContextV1 } from '@platform/contracts'
import { describe, expect, it } from 'vitest'

import { ProtectedArtifactStore } from './artifact-store.js'
import { MemoryProtectedArtifactMetadataStore } from './memory-metadata.js'
import type { PrivateBlobClient } from './types.js'

const organizationId = '00000000-0000-4000-8000-000000000801'
const otherOrganizationId = '00000000-0000-4000-8000-000000000802'
const projectId = '00000000-0000-4000-8000-000000000803'
const otherProjectId = '00000000-0000-4000-8000-000000000804'
const runId = '00000000-0000-4000-8000-000000000805'

describe('Vercel Private Blob protected artifact boundary', () => {
  it('uploads, verifies, reads, and deletes only in the owning tenant and project', async () => {
    const blobs = new MemoryBlobClient()
    const store = new ProtectedArtifactStore(blobs, new MemoryProtectedArtifactMetadataStore())
    const content = new TextEncoder().encode('artifact')
    const reference = await store.put(context(), content, {
      mediaType: 'text/plain',
      retentionClass: 'standard',
      runId,
    })

    expect(blobs.paths()).toEqual([
      `tenants/${organizationId}/projects/${projectId}/runs/${runId}/artifacts/${reference.uri.slice(-36)}`,
    ])
    await expect(store.read(context(), reference)).resolves.toEqual(content)
    await expect(store.read(context(otherOrganizationId), reference)).rejects.toThrow(
      /authorized project scope/u,
    )
    await expect(store.read(context(organizationId, otherProjectId), reference)).rejects.toThrow(
      /authorized project scope/u,
    )
    await store.delete(context(), reference)
    await expect(store.read(context(), reference)).rejects.toThrow(/authorized project scope/u)
  })

  it('rejects oversized and unapproved content before Blob access', async () => {
    const blobs = new MemoryBlobClient()
    const store = new ProtectedArtifactStore(blobs, new MemoryProtectedArtifactMetadataStore(), {
      maxObjectBytes: 1_024,
    })
    await expect(
      store.put(context(), new Uint8Array(1_025), {
        mediaType: 'application/octet-stream',
        retentionClass: 'ephemeral',
        runId,
      }),
    ).rejects.toThrow(/object-size limit/u)
    await expect(
      store.put(context(), new Uint8Array(1), {
        mediaType: 'text/html',
        retentionClass: 'ephemeral',
        runId,
      }),
    ).rejects.toThrow(/media type/u)
    expect(blobs.paths()).toEqual([])
  })

  it('detects digest mismatch on read', async () => {
    const blobs = new MemoryBlobClient()
    const store = new ProtectedArtifactStore(blobs, new MemoryProtectedArtifactMetadataStore())
    const reference = await store.put(context(), new TextEncoder().encode('original'), {
      mediaType: 'text/plain',
      retentionClass: 'standard',
      runId,
    })
    blobs.replace(blobs.paths()[0]!, new TextEncoder().encode('tampered'))
    await expect(store.read(context(), reference)).rejects.toThrow(/integrity verification/u)
  })

  it('garbage-collects expired artifacts and preserves pinned artifacts', async () => {
    let now = new Date('2026-08-18T00:00:00.000Z')
    const blobs = new MemoryBlobClient()
    const metadata = new MemoryProtectedArtifactMetadataStore()
    const store = new ProtectedArtifactStore(blobs, metadata, { clock: () => now })
    const expired = await store.put(context(), new TextEncoder().encode('ephemeral'), {
      mediaType: 'text/plain',
      retentionClass: 'ephemeral',
      runId,
    })
    const pinned = await store.put(context(), new TextEncoder().encode('pinned'), {
      mediaType: 'text/plain',
      retentionClass: 'pinned',
      runId,
    })
    now = new Date('2026-08-19T00:00:00.001Z')

    await expect(store.collectExpired()).resolves.toBe(1)
    await expect(store.read(context(), expired)).rejects.toThrow(/authorized project scope/u)
    await expect(store.read(context(), pinned)).resolves.toEqual(new TextEncoder().encode('pinned'))
  })
})

class MemoryBlobClient implements PrivateBlobClient {
  readonly #objects = new Map<string, Uint8Array>()

  put(input: {
    readonly content: Uint8Array
    readonly mediaType: string
    readonly path: string
  }): Promise<void> {
    if (this.#objects.has(input.path)) throw new Error('Blob already exists.')
    this.#objects.set(input.path, input.content.slice())
    return Promise.resolve()
  }

  get(path: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.#objects.get(path)?.slice())
  }

  delete(path: string): Promise<void> {
    this.#objects.delete(path)
    return Promise.resolve()
  }

  paths() {
    return [...this.#objects.keys()].sort()
  }

  replace(path: string, content: Uint8Array) {
    this.#objects.set(path, content)
  }
}

function context(
  currentOrganizationId = organizationId,
  currentProjectId = projectId,
): ProviderRequestContextV1 {
  return {
    schemaVersion: '1',
    organizationId: currentOrganizationId,
    projectId: currentProjectId,
    actorRef: 'service:00000000-0000-4000-8000-000000000806',
    correlationId: '00000000-0000-4000-8000-000000000807',
    idempotencyKey: createHash('sha256')
      .update(`${currentOrganizationId}:${currentProjectId}`)
      .digest('hex'),
    requestedAt: '2026-08-18T00:00:00.000Z',
  }
}
