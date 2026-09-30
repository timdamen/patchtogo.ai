import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { request as upstreamRequest } from 'undici'
import type { RunTokens } from './run-tokens.ts'

const ANTHROPIC_API = 'https://api.anthropic.com'
const ANTHROPIC_MAX_REQUEST_BYTES = 32 * 1024 * 1024

const DROPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'anthropic-workspace-id',
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
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
  'proxy-connection',
  'transfer-encoding',
  'trailer',
  'upgrade',
  'content-length',
  'set-cookie'
])

export interface ModelProxyOptions {
  tokens: RunTokens
  apiKey: string
  workspaceId?: string
  maxRequestBytes?: number
}

export function createModelProxy(options: ModelProxyOptions): FastifyPluginAsync {
  const { tokens, apiKey, workspaceId, maxRequestBytes = ANTHROPIC_MAX_REQUEST_BYTES } = options

  async function forward(request: FastifyRequest, reply: FastifyReply, path: string) {
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && !DROPPED_REQUEST_HEADERS.has(name)) headers[name] = value
    }
    headers['x-api-key'] = apiKey
    if (workspaceId) headers['anthropic-workspace-id'] = workspaceId

    const target = new URL(path, ANTHROPIC_API)
    target.search = new URL(request.url, ANTHROPIC_API).search

    const disconnected = new AbortController()
    reply.raw.once('close', () => disconnected.abort())

    let upstream: Awaited<ReturnType<typeof upstreamRequest>>
    try {
      upstream = await upstreamRequest(target, {
        method: request.method === 'GET' ? 'GET' : 'POST',
        headers,
        body: Buffer.isBuffer(request.body) ? request.body : undefined,
        signal: disconnected.signal
      })
    } catch {
      return reply.code(502).send(anthropicError('api_error', 'upstream unavailable'))
    }

    reply.code(upstream.statusCode)
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) reply.header(name, value)
    }
    return reply.send(upstream.body)
  }

  return async (proxy) => {
    proxy.removeAllContentTypeParsers()
    proxy.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body)
    )

    proxy.addHook('onRequest', async (request, reply) => {
      const token = presentedToken(request.headers)
      const claims = token ? await tokens.verify(token) : null
      if (!claims) {
        return reply.code(401).send(anthropicError('authentication_error', 'invalid run token'))
      }
    })

    proxy.setNotFoundHandler((_request, reply) =>
      reply.code(404).send(anthropicError('not_found_error', 'not found'))
    )

    proxy.setErrorHandler((error: { statusCode?: number }, request, reply) => {
      const status = error.statusCode ?? 500
      if (status === 413) {
        return reply
          .code(413)
          .send(anthropicError('request_too_large', `request exceeds ${maxRequestBytes} bytes`))
      }
      if (status < 500) {
        return reply.code(status).send(anthropicError('invalid_request_error', 'invalid request'))
      }
      request.log.error(error)
      return reply.code(500).send(anthropicError('api_error', 'internal error'))
    })

    const limited = { bodyLimit: maxRequestBytes }
    proxy.post('/v1/messages', limited, (request, reply) => forward(request, reply, '/v1/messages'))
    proxy.post('/v1/messages/count_tokens', limited, (request, reply) =>
      forward(request, reply, '/v1/messages/count_tokens')
    )
    proxy.get('/v1/models', (request, reply) => forward(request, reply, '/v1/models'))
    proxy.get<{ Params: { id: string } }>('/v1/models/:id', (request, reply) =>
      forward(request, reply, `/v1/models/${encodeURIComponent(request.params.id)}`)
    )
  }
}

function presentedToken(headers: FastifyRequest['headers']) {
  const authorization = headers.authorization
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length).trim()
  const apiKey = headers['x-api-key']
  return (typeof apiKey === 'string' && apiKey.trim()) || null
}

function anthropicError(type: string, message: string) {
  return { type: 'error', error: { type, message } }
}
