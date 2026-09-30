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

  it('announces an opened patch PR with its link', async () => {
    const api = discord()

    await createDiscordNotifier({ webhookUrl: WEBHOOK, fetch: api.fetch }).notify({
      type: 'patch-pr-opened',
      runId: notification.runId,
      ghsaId: notification.ghsaId,
      packageName: notification.packageName,
      url: 'https://github.com/patchtogo-ai/lodash.set/pull/1'
    })

    const content = String(api.requests[0]?.body.content)
    expect(content).toContain('Patch PR ready for review')
    expect(content).toContain('`lodash.set`')
    expect(content).toContain('<https://github.com/patchtogo-ai/lodash.set/pull/1>')
    expect(api.requests[0]?.body.allowed_mentions).toEqual({ parse: [] })
  })

  it.each([
    [
      {
        type: 'upstream-pr-ready',
        compareUrl:
          'https://github.com/o/r/compare/main...patchtogo-ai:r:ptg/upstream/r/1.0.0/ghsa-x?expand=1'
      },
      [
        '<https://github.com/o/r/compare/main...patchtogo-ai:r:ptg/upstream/r/1.0.0/ghsa-x?expand=1>',
        '`pnpm --filter agent retry GHSA-p6mc-m468-83gw:lodash.set`'
      ]
    ],
    [
      {
        type: 'superseded',
        version: '4.3.3',
        command: "npm deprecate '@patchtogo.ai/lodash.set@4.3.2-ptg.1' 'Superseded'"
      },
      ["```sh\nnpm deprecate '@patchtogo.ai/lodash.set@4.3.2-ptg.1' 'Superseded'\n```"]
    ],
    [
      {
        type: 'repository-advisory',
        patchedPackage: '@patchtogo.ai/lodash.set',
        url: 'https://github.com/patchtogo-ai/lodash.set/security/advisories/GHSA-aaaa-bbbb-cccc',
        patchedVersion: null
      },
      [
        '**Advisory published:** GHSA-p6mc-m468-83gw in `lodash.set` also affects `@patchtogo.ai/lodash.set`',
        '<https://github.com/patchtogo-ai/lodash.set/security/advisories/GHSA-aaaa-bbbb-cccc>'
      ]
    ],
    [
      {
        type: 'repository-advisory',
        patchedPackage: '@patchtogo.ai/lodash.set',
        url: 'https://github.com/patchtogo-ai/lodash.set/security/advisories/GHSA-aaaa-bbbb-cccc',
        patchedVersion: '4.3.2-ptg.2'
      },
      ['**Advisory patched:** `@patchtogo.ai/lodash.set` `4.3.2-ptg.2` fixes GHSA-p6mc-m468-83gw']
    ]
  ] as const)('gives the operator what to act on for %o', async (extra, expected) => {
    const api = discord()
    const { runId, ghsaId, packageName } = notification

    await createDiscordNotifier({ webhookUrl: WEBHOOK, fetch: api.fetch }).notify({
      runId,
      ghsaId,
      packageName,
      ...extra
    })

    const content = String(api.requests[0]?.body.content)
    for (const text of expected) expect(content).toContain(text)
  })

  it('marks every message about a test advisory as a patchtogo test', async () => {
    const api = discord()
    const notifier = createDiscordNotifier({ webhookUrl: WEBHOOK, fetch: api.fetch })

    await notifier.notify({ ...notification, ghsaId: 'GHSA-ptg0-dry0-run1' })
    await notifier.notify(notification)

    const contents = api.requests.map((request) => String(request.body.content))
    expect(contents[0]).toMatch(/^\[patchtogo test\] \*\*Needs a human:\*\*/)
    expect(contents[1]).toMatch(/^\*\*Needs a human:\*\*/)
  })

  it('fails when Discord refuses the message, so the pipeline records the step as failed', async () => {
    const api = discord(429)

    await expect(
      createDiscordNotifier({ webhookUrl: WEBHOOK, fetch: api.fetch }).notify(notification)
    ).rejects.toThrow(/429/)
  })
})
