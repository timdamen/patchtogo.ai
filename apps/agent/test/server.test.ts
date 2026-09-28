import { Webhooks } from '@octokit/webhooks'
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/server.ts'

const webhooks = new Webhooks({ secret: 'test-secret' })
const app = createServer(webhooks)
const payload = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 })

function post(signature: string) {
  return app.request('/webhooks/github', {
    method: 'POST',
    headers: {
      'x-github-delivery': 'delivery-1',
      'x-github-event': 'ping',
      'x-hub-signature-256': signature,
      'content-type': 'application/json'
    },
    body: payload
  })
}

describe('server', () => {
  it('reports health', async () => {
    const response = await app.request('/health')
    expect(await response.json()).toEqual({ ok: true })
  })

  it('accepts a correctly signed webhook', async () => {
    const response = await post(await webhooks.sign(payload))
    expect(response.status).toBe(202)
  })

  it('rejects a webhook with a bad signature', async () => {
    const response = await post('sha256=deadbeef')
    expect(response.status).toBe(401)
  })
})
