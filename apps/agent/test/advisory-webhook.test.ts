import { Webhooks } from '@octokit/webhooks'
import { describe, expect, it } from 'vitest'
import { forwardSecurityAdvisories } from '../src/advisory-webhook.ts'
import type { PipelineEvent } from '../src/pipeline/events.ts'
import { createServer } from '../src/server.ts'

const ghsaId = 'GHSA-p6mc-m468-83gw'

function securityAdvisory(action: string, id = ghsaId) {
  return JSON.stringify({ action, security_advisory: { ghsa_id: id } })
}

function securityAdvisoryWebhook() {
  const webhooks = new Webhooks({ secret: 'test-secret' })
  const events: PipelineEvent[] = []
  forwardSecurityAdvisories(webhooks, async (event) => {
    events.push(event)
  })
  const app = createServer(webhooks)

  async function deliver(action: string, options: { signedBody?: string } = {}) {
    const body = securityAdvisory(action)
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'security_advisory',
        'x-hub-signature-256': await webhooks.sign(options.signedBody ?? body),
        'content-type': 'application/json'
      },
      payload: body
    })
    return { status: response.statusCode }
  }

  return { events, deliver }
}

describe('security_advisory webhook', () => {
  it.each(['published', 'updated'])('turns a %s advisory into a pipeline event', async (action) => {
    const { events, deliver } = securityAdvisoryWebhook()

    const response = await deliver(action)

    expect(response.status).toBe(202)
    expect(events).toEqual([{ type: 'advisory-published', ghsaId }])
  })

  it('ignores a withdrawn advisory', async () => {
    const { events, deliver } = securityAdvisoryWebhook()

    const response = await deliver('withdrawn')

    expect(response.status).toBe(202)
    expect(events).toEqual([])
  })

  it('rejects a delivery signed for another body without emitting anything', async () => {
    const { events, deliver } = securityAdvisoryWebhook()

    const response = await deliver('published', {
      signedBody: securityAdvisory('published', 'GHSA-other')
    })

    expect(response.status).toBe(401)
    expect(events).toEqual([])
  })
})
