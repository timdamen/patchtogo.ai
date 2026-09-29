import { Webhooks } from '@octokit/webhooks'
import { beforeEach, describe, expect, it } from 'vitest'
import { createModelProxy } from '../src/model-proxy.ts'
import { createMemoryRevocationStore, createRunTokens } from '../src/run-tokens.ts'
import { createServer } from '../src/server.ts'

const API_KEY = 'sk-ant-real-key-never-leaks'
const SECRET = 'a-run-token-secret-that-is-long-enough'
const HOUR = 60 * 60 * 1000

let clock: number
let upstreamCalls: Request[]
let upstreamResponse: () => Response | Promise<Response>

const now = () => clock
const tokens = createRunTokens({
  secret: SECRET,
  revocations: createMemoryRevocationStore(),
  now
})
const app = createServer(new Webhooks({ secret: 'test-secret' }), {
  modelProxy: createModelProxy({
    tokens,
    apiKey: API_KEY,
    workspaceId: 'wrkspc_test',
    fetch: async (input, init) => {
      upstreamCalls.push(new Request(input, init))
      return upstreamResponse()
    }
  })
})

const messageBody = JSON.stringify({
  model: 'claude-opus-5-5',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }]
})

function send(headers: Record<string, string>, path = '/model-proxy/v1/messages?beta=true') {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
    body: messageBody
  })
}

function upstreamCall() {
  const call = upstreamCalls.at(-1)
  if (!call) throw new Error('Anthropic was never called')
  return call
}

async function expectKeyHidden(response: Response) {
  expect([...response.headers].join('\n')).not.toContain(API_KEY)
  expect(await response.text()).not.toContain(API_KEY)
}

beforeEach(() => {
  clock = Date.UTC(2026, 8, 28)
  upstreamCalls = []
  upstreamResponse = () =>
    Response.json({ id: 'msg_1', type: 'message' }, { headers: { 'request-id': 'req_1' } })
})

describe('model proxy', () => {
  it('forwards a request with a valid run token using the real key', async () => {
    const { token } = tokens.issue('run-1', HOUR)
    const response = await send({ authorization: `Bearer ${token}` })

    expect(response.status).toBe(200)
    expect(response.headers.get('request-id')).toBe('req_1')
    expect(await response.json()).toEqual({ id: 'msg_1', type: 'message' })

    expect(upstreamCalls).toHaveLength(1)
    const call = upstreamCall()
    expect(call.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
    expect(call.method).toBe('POST')
    expect(call.headers.get('x-api-key')).toBe(API_KEY)
    expect(call.headers.get('anthropic-workspace-id')).toBe('wrkspc_test')
    expect(call.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(call.headers.get('authorization')).toBeNull()
    expect(await call.text()).toBe(messageBody)
  })

  it('accepts the run token in the x-api-key header', async () => {
    const { token } = tokens.issue('run-1', HOUR)
    const response = await send({ 'x-api-key': token })

    expect(response.status).toBe(200)
    expect(upstreamCall().headers.get('x-api-key')).toBe(API_KEY)
  })

  it('streams server-sent events back as they arrive', async () => {
    const encoder = new TextEncoder()
    let push!: (chunk: string) => void
    let close!: () => void
    upstreamResponse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            push = (chunk) => controller.enqueue(encoder.encode(chunk))
            close = () => controller.close()
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )

    const { token } = tokens.issue('run-1', HOUR)
    const response = await send({ authorization: `Bearer ${token}` })
    expect(response.headers.get('content-type')).toBe('text/event-stream')

    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    push('event: message_start\ndata: {"type":"message_start"}\n\n')
    expect((await reader.read()).value).toBe(
      'event: message_start\ndata: {"type":"message_start"}\n\n'
    )

    push('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    close()
    expect((await reader.read()).value).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    )
    expect((await reader.read()).done).toBe(true)
  })

  it('passes upstream errors through unchanged', async () => {
    upstreamResponse = () =>
      Response.json(
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        { status: 529 }
      )
    const { token } = tokens.issue('run-1', HOUR)
    const response = await send({ authorization: `Bearer ${token}` })

    expect(response.status).toBe(529)
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' }
    })
  })

  describe('rejects without reaching Anthropic', () => {
    it('a request without a token', async () => {
      const response = await send({})
      expect(response.status).toBe(401)
      await expectKeyHidden(response)
      expect(upstreamCalls).toHaveLength(0)
    })

    it('a token signed with another secret', async () => {
      const forger = createRunTokens({
        secret: 'some-other-secret-that-is-long-enough',
        revocations: createMemoryRevocationStore()
      })
      const response = await send({ authorization: `Bearer ${forger.issue('run-1', HOUR).token}` })
      expect(response.status).toBe(401)
      expect(upstreamCalls).toHaveLength(0)
    })

    it('a token whose claims were altered', async () => {
      const [prefix, , signature] = tokens.issue('run-1', HOUR).token.split('.')
      const payload = Buffer.from(
        JSON.stringify({ run: 'run-2', jti: 'x', exp: clock + 100 * HOUR })
      ).toString('base64url')
      const response = await send({ authorization: `Bearer ${prefix}.${payload}.${signature}` })
      expect(response.status).toBe(401)
      expect(upstreamCalls).toHaveLength(0)
    })

    it('the real API key presented as a token', async () => {
      const response = await send({ 'x-api-key': API_KEY })
      expect(response.status).toBe(401)
      await expectKeyHidden(response)
      expect(upstreamCalls).toHaveLength(0)
    })

    it('an expired token', async () => {
      const { token } = tokens.issue('run-1', HOUR)
      clock += HOUR
      const response = await send({ authorization: `Bearer ${token}` })
      expect(response.status).toBe(401)
      expect(upstreamCalls).toHaveLength(0)
    })

    it('a revoked token', async () => {
      const { token } = tokens.issue('run-1', HOUR)
      expect((await send({ authorization: `Bearer ${token}` })).status).toBe(200)

      await tokens.revoke(token)
      const response = await send({ authorization: `Bearer ${token}` })
      expect(response.status).toBe(401)
      expect(upstreamCalls).toHaveLength(1)
    })

    it('a path outside the messages and models API', async () => {
      const { token } = tokens.issue('run-1', HOUR)
      const response = await send({ authorization: `Bearer ${token}` }, '/model-proxy/v1/files')
      expect(response.status).toBe(404)
      expect(upstreamCalls).toHaveLength(0)
    })
  })

  it('does not leak the key when Anthropic is unreachable', async () => {
    upstreamResponse = () => {
      throw new Error(`connect failed with x-api-key ${API_KEY}`)
    }
    const { token } = tokens.issue('run-1', HOUR)
    const response = await send({ authorization: `Bearer ${token}` })

    expect(response.status).toBe(502)
    await expectKeyHidden(response)
  })
})
