import { Webhooks } from '@octokit/webhooks'
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/server.ts'

describe('server', () => {
  it('reports health', async () => {
    const app = createServer(new Webhooks({ secret: 'test-secret' }))
    const response = await app.request('/health')
    expect(await response.json()).toEqual({ ok: true })
  })
})
