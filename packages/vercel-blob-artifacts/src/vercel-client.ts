import { del, get, put } from '@vercel/blob'

import type { PrivateBlobClient } from './types.js'

export class VercelPrivateBlobClient implements PrivateBlobClient {
  async put(input: {
    readonly content: Uint8Array
    readonly mediaType: string
    readonly path: string
  }): Promise<void> {
    await put(input.path, Buffer.from(input.content), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: input.mediaType,
    })
  }

  async get(path: string): Promise<Uint8Array | undefined> {
    const result = await get(path, { access: 'private' })
    if (result === null || result.statusCode !== 200) return undefined
    return new Uint8Array(await new Response(result.stream).arrayBuffer())
  }

  async delete(path: string): Promise<void> {
    await del(path)
  }
}
