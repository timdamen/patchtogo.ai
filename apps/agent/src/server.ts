import { Hono } from 'hono'
import type { Webhooks } from '@octokit/webhooks'

export function createServer(webhooks: Webhooks, options: { modelProxy?: Hono } = {}) {
  const app = new Hono()

  if (options.modelProxy) app.route('/model-proxy', options.modelProxy)

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/webhooks/github', async (c) => {
    const id = c.req.header('x-github-delivery')
    const name = c.req.header('x-github-event')
    const signature = c.req.header('x-hub-signature-256')
    if (!id || !name || !signature) return c.json({ error: 'missing GitHub headers' }, 400)

    const payload = await c.req.text()
    if (!(await webhooks.verify(payload, signature))) {
      return c.json({ error: 'invalid signature' }, 401)
    }

    await webhooks.receive({ id, name, payload: JSON.parse(payload) } as Parameters<
      Webhooks['receive']
    >[0])
    return c.body(null, 202)
  })

  return app
}
