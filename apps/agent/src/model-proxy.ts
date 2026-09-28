import { Hono, type Context } from 'hono'
import type { RunTokens } from './run-tokens.ts'

const DROPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'anthropic-workspace-id',
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
  'cookie',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip'
])

const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'set-cookie'
])

export interface ModelProxyOptions {
  tokens: RunTokens
  apiKey: string
  workspaceId?: string
  upstream?: string
  fetch?: typeof globalThis.fetch
}

export function createModelProxy(options: ModelProxyOptions) {
  const { tokens, apiKey, workspaceId, upstream = 'https://api.anthropic.com' } = options
  const upstreamFetch = options.fetch ?? globalThis.fetch
  const app = new Hono()

  app.use('*', async (c, next) => {
    const token = presentedToken(c.req.raw.headers)
    const claims = token ? await tokens.verify(token) : null
    if (!claims) return c.json(anthropicError('authentication_error', 'invalid run token'), 401)
    await next()
  })

  async function forward(c: Context, path: string) {
    const headers = new Headers()
    for (const [name, value] of c.req.raw.headers) {
      if (!DROPPED_REQUEST_HEADERS.has(name)) headers.set(name, value)
    }
    headers.set('x-api-key', apiKey)
    if (workspaceId) headers.set('anthropic-workspace-id', workspaceId)

    const method = c.req.method
    const body = method === 'GET' ? undefined : await c.req.arrayBuffer()
    const target = new URL(path, upstream)
    target.search = new URL(c.req.url).search

    let response: Response
    try {
      response = await upstreamFetch(target, { method, headers, body, signal: c.req.raw.signal })
    } catch {
      return c.json(anthropicError('api_error', 'upstream unavailable'), 502)
    }

    const responseHeaders = new Headers()
    for (const [name, value] of response.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name)) responseHeaders.set(name, value)
    }
    return new Response(response.body, { status: response.status, headers: responseHeaders })
  }

  app.post('/v1/messages', (c) => forward(c, '/v1/messages'))
  app.post('/v1/messages/count_tokens', (c) => forward(c, '/v1/messages/count_tokens'))
  app.get('/v1/models', (c) => forward(c, '/v1/models'))
  app.get('/v1/models/:id', (c) =>
    forward(c, `/v1/models/${encodeURIComponent(c.req.param('id'))}`)
  )

  return app
}

function presentedToken(headers: Headers) {
  const authorization = headers.get('authorization')
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length).trim()
  return headers.get('x-api-key')?.trim() || null
}

function anthropicError(type: string, message: string) {
  return { type: 'error', error: { type, message } }
}
