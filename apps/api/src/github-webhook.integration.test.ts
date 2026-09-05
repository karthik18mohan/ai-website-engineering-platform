import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApi } from './app.js'
import { loadApiConfig } from './config.js'

const apps: ReturnType<typeof buildApi>[] = []
afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())))

describe('GitHub webhook API boundary', () => {
  it('preserves exact raw bytes and required GitHub delivery headers', async () => {
    const handle = vi.fn(() => Promise.resolve([{ status: 'accepted' }]))
    const app = buildApi({
      config: loadApiConfig({ AUTH_MODE: 'test', LOG_LEVEL: 'silent', NODE_ENV: 'test' }),
      githubWebhookHandler: { handle },
    })
    apps.push(app)
    const payload = '{"installation":{"id":154456584},"repository":{"id":1303930605}}'
    const response = await app.inject({
      method: 'POST',
      url: '/v1/providers/github/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': '00000000-0000-4000-8000-000000000801',
        'x-github-event': 'push',
        'x-hub-signature-256': `sha256=${'a'.repeat(64)}`,
      },
      payload,
    })

    expect(response.statusCode).toBe(200)
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'push' }),
      Buffer.from(payload),
    )
  })

  it('rejects missing signatures before calling provider processing', async () => {
    const handle = vi.fn(() => Promise.resolve([{ status: 'accepted' }]))
    const app = buildApi({
      config: loadApiConfig({ AUTH_MODE: 'test', LOG_LEVEL: 'silent', NODE_ENV: 'test' }),
      githubWebhookHandler: { handle },
    })
    apps.push(app)
    const response = await app.inject({
      method: 'POST',
      url: '/v1/providers/github/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'push',
      },
      payload: '{}',
    })
    expect(response.statusCode).toBe(400)
    expect(handle).not.toHaveBeenCalled()
  })
})
