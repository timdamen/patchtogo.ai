import { describe, expect, it } from 'vitest'
import { createDiscordNotifier } from '../src/notifier.ts'
import type { NeedsHumanNotification } from '../src/pipeline/ports.ts'

const WEBHOOK = 'https://discord.com/api/webhooks/123/secret-token'

const notification: NeedsHumanNotification = {
  type: 'needs-human',
  runId: 'GHSA-p6mc-m468-83gw:lodash.set',
  ghsaId: 'GHSA-p6mc-m468-83gw',
  packageName: 'lodash.set',
  reason: 'The fix needs a breaking API change.'
}

function discord(status = 204) {
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = []
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init, body: JSON.parse(String(init.body)) })
    return new Response(null, { status })
  }
  return { requests, fetch }
}

describe('the Discord notifier', () => {
  it('posts a needs-human notification to the configured webhook', async () => {
    const api = discord()

    await createDiscordNotifier({ webhookUrl: WEBHOOK, fetch: api.fetch }).notify(notification)

    expect(api.requests).toHaveLength(1)
    const [request] = api.requests
    expect(request?.url).toBe(WEBHOOK)
    expect(request?.init.method).toBe('POST')
    expect(new Headers(request?.init.headers).get('content-type')).toBe('application/json')
    const content = String(request?.body.content)
    expect(content).toContain('Needs a human')
    expect(content).toContain('`lodash.set`')
    expect(content).toContain('https://github.com/advisories/GHSA-p6mc-m468-83gw')
    expect(content).toContain(notification.reason)
  })

  it('keeps untrusted reason text inert: no pings, no links, no escaping the block', async () => {
    const api = discord()
    const reason = '@everyone ``` [click](https://evil.example) <@123>\n'.repeat(100)

    await createDiscordNotifier({ webhookUrl: WEBHOOK, fetch: api.fetch }).notify({
      ...notification,
      reason
    })

    const body = api.requests[0]?.body ?? {}
    expect(body.allowed_mentions).toEqual({ parse: [] })
    expect(body.flags).toBe(4)
    const content = String(body.content)
    expect(content.length).toBeLessThanOrEqual(2000)
    expect(content.match(/```/g)).toHaveLength(2)
    expect(content.trimEnd().endsWith('```')).toBe(true)
  })

  it('fails when Discord refuses the message, so the pipeline records the step as failed', async () => {
    const api = discord(429)

    await expect(
      createDiscordNotifier({ webhookUrl: WEBHOOK, fetch: api.fetch }).notify(notification)
    ).rejects.toThrow(/429/)
  })
})
