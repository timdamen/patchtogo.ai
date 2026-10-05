import { once } from 'node:events'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { Webhooks } from '@octokit/webhooks'
import { request } from 'undici'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createModelProxy } from '../src/model-proxy.ts'
import { createMemoryRevocationStore, createRunTokens } from '../src/run-tokens.ts'
import { createServer } from '../src/server.ts'
import { fakeAnthropic, type FakeAnthropic } from './support/anthropic-upstream.ts'

const MAX_BYTES = 1024
const CLOSE_GRACE_MS = 200

const webhooks = new Webhooks({ secret: 'test-secret' })
const deliveries: string[] = []
webhooks.onAny(({ id }) => {
  deliveries.push(id)
})

const tokens = createRunTokens({
  secret: 'a-run-token-secret-that-is-long-enough',
  revocations: createMemoryRevocationStore()
})

function bootServer() {
  return createServer(webhooks, {
    webhookMaxBytes: MAX_BYTES,
    closeGraceMs: CLOSE_GRACE_MS,
    modelProxy: createModelProxy({
      tokens,
      apiKey: 'sk-ant-real-key',
      maxRequestBytes: MAX_BYTES
    })
  })
}

let anthropic: FakeAnthropic
let server: ReturnType<typeof bootServer>
let origin: string

beforeAll(async () => {
  anthropic = await fakeAnthropic()
  server = bootServer()
  origin = await server.listen({ port: 0, host: '127.0.0.1' })
})

afterAll(async () => {
  await server.close()
  await anthropic.close()
})

function deliver(delivery: string, body: string, signature: string) {
  return request(`${origin}/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': delivery,
      'x-github-event': 'ping',
      'x-hub-signature-256': signature
    },
    body
  })
}

async function openProxiedStream(address: string, signal?: AbortSignal) {
  let send!: (event: string) => void
  let opened!: () => void
  let closed!: () => void
  const upstreamOpened = new Promise<void>((resolve) => (opened = resolve))
  const upstreamClosed = new Promise<void>((resolve) => (closed = resolve))
  anthropic.respondWith((response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('event: message_start\n\n')
    send = (event) => response.write(event)
    response.on('close', closed)
    opened()
  })

  const responding = request(`${address}/model-proxy/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${tokens.issue('run-1', 60_000).token}`
    },
    body: '{}',
    signal
  })
  await upstreamOpened
  return { response: await responding, send, upstreamClosed }
}

describe('the listening server', () => {
  it('reports health', async () => {
    const response = await request(`${origin}/health`)
    expect(response.statusCode).toBe(200)
    expect(await response.body.json()).toEqual({ ok: true })
  })

  it('accepts a signed webhook and rejects a badly signed one', async () => {
    const body = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 })

    const signed = await deliver('signed', body, await webhooks.sign(body))
    const forged = await deliver('forged', body, await webhooks.sign(`${body} `))

    expect(signed.statusCode).toBe(202)
    expect(forged.statusCode).toBe(401)
    expect(deliveries).toEqual(['signed'])
  })

  it('streams a proxied response and cancels Anthropic when the client disconnects', async () => {
    const client = new AbortController()
    const { response, send, upstreamClosed } = await openProxiedStream(origin, client.signal)
    expect(response.headers['content-type']).toBe('text/event-stream')

    const events = response.body[Symbol.asyncIterator]()
    expect(String((await events.next()).value)).toBe('event: message_start\n\n')
    send('event: content_block_start\n\n')
    expect(String((await events.next()).value)).toBe('event: content_block_start\n\n')

    client.abort()
    await upstreamClosed
  })

  it('cancels Anthropic when the client disconnects before the response starts', async () => {
    let received!: () => void
    let closed!: () => void
    const upstreamReceived = new Promise<void>((resolve) => (received = resolve))
    const upstreamClosed = new Promise<void>((resolve) => (closed = resolve))
    anthropic.respondWith((response) => {
      response.on('close', closed)
      received()
    })

    const client = new AbortController()
    const responding = request(`${origin}/model-proxy/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokens.issue('run-1', 60_000).token}`
      },
      body: '{}',
      signal: client.signal
    }).catch(() => undefined)
    await upstreamReceived

    client.abort()
    await responding
    await upstreamClosed
  })

  it.each([
    { route: 'webhook', path: '/webhooks/github' },
    { route: 'model proxy', path: '/model-proxy/v1/messages' }
  ])('answers 413 to an oversized $route body while it is still arriving', async ({ path }) => {
    const upload = httpRequest(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'oversized',
        'x-github-event': 'ping',
        'x-hub-signature-256': 'sha256=0',
        authorization: `Bearer ${tokens.issue('run-1', 60_000).token}`
      }
    })
    upload.write('x'.repeat(MAX_BYTES + 1))

    const [response] = (await once(upload, 'response')) as [IncomingMessage]
    upload.destroy()
    expect(response.statusCode).toBe(413)
    expect(upload.writableEnded).toBe(false)
  })
})

describe('closing the server', () => {
  it('cuts a proxied stream that outlives the grace period', async () => {
    const closing = bootServer()
    const { response, upstreamClosed } = await openProxiedStream(
      await closing.listen({ port: 0, host: '127.0.0.1' })
    )
    response.body.resume()

    const started = Date.now()
    await closing.close()

    expect(Date.now() - started).toBeGreaterThanOrEqual(CLOSE_GRACE_MS - 20)
    await upstreamClosed
  })
})
