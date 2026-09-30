import Fastify, {
  type FastifyPluginAsync,
  type FastifyRequest,
  type FastifyServerOptions
} from 'fastify'
import type { Webhooks } from '@octokit/webhooks'

const GITHUB_WEBHOOK_MAX_BYTES = 25 * 1024 * 1024
const CLOSE_GRACE_MS = 10_000

const REDACTED_HEADERS = [
  'authorization',
  'x-api-key',
  'x-hub-signature',
  'x-hub-signature-256',
  'cookie',
  'set-cookie',
  'proxy-authorization'
]

const LOGGER = {
  level: 'info',
  redact: {
    paths: REDACTED_HEADERS.map((name) => `req.headers["${name}"]`),
    censor: '[redacted]'
  },
  serializers: {
    req: (request: FastifyRequest) => ({
      method: request.method,
      url: request.url,
      headers: request.headers,
      remoteAddress: request.ip
    })
  }
} satisfies FastifyServerOptions['logger']

export interface ServerOptions {
  modelProxy?: FastifyPluginAsync
  webhookMaxBytes?: number
  closeGraceMs?: number
  logger?: boolean
}

export function createServer(webhooks: Webhooks, options: ServerOptions = {}) {
  const {
    webhookMaxBytes = GITHUB_WEBHOOK_MAX_BYTES,
    closeGraceMs = CLOSE_GRACE_MS,
    logger = false
  } = options

  const app = Fastify({ logger: logger && LOGGER })

  app.setErrorHandler((error: { statusCode?: number; message: string }, request, reply) => {
    const status = error.statusCode ?? 500
    if (status >= 500) {
      request.log.error(error)
      return reply.code(status).send({ error: 'internal error' })
    }
    return reply.code(status).send({ error: error.message })
  })

  app.addHook('preClose', (done) => {
    setTimeout(() => app.server.closeAllConnections(), closeGraceMs).unref()
    done()
  })

  if (options.modelProxy) app.register(options.modelProxy, { prefix: '/model-proxy' })

  app.get('/health', async () => ({ ok: true }))

  app.register(async (github) => {
    github.removeAllContentTypeParsers()
    github.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) =>
      done(null, body)
    )

    github.post(
      '/webhooks/github',
      {
        bodyLimit: webhookMaxBytes,
        onRequest: async (request, reply) => {
          const { headers } = request
          if (
            !headers['x-github-delivery'] ||
            !headers['x-github-event'] ||
            !headers['x-hub-signature-256']
          ) {
            return reply.code(400).send({ error: 'missing GitHub headers' })
          }
        }
      },
      async (request, reply) => {
        const id = String(request.headers['x-github-delivery'])
        const name = String(request.headers['x-github-event'])
        const signature = String(request.headers['x-hub-signature-256'])
        const payload = typeof request.body === 'string' ? request.body : ''

        if (!(await webhooks.verify(payload, signature))) {
          return reply.code(401).send({ error: 'invalid signature' })
        }

        await webhooks.receive({ id, name, payload: JSON.parse(payload) } as Parameters<
          Webhooks['receive']
        >[0])
        return reply.code(202).send()
      }
    )
  })

  return app
}
