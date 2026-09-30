import { Webhooks } from '@octokit/webhooks'
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createModelProxy } from '../src/model-proxy.ts'
import { createMemoryRevocationStore, createRunTokens } from '../src/run-tokens.ts'
import { createServer } from '../src/server.ts'
import { fakeAnthropic, type FakeAnthropic } from './support/anthropic-upstream.ts'

const API_KEY = 'sk-ant-real-key-never-leaks'
const SECRET = 'a-run-token-secret-that-is-long-enough'
const HOUR = 60 * 60 * 1000

let clock: number
let anthropic: FakeAnthropic

const now = () => clock
const tokens = createRunTokens({
  secret: SECRET,
  revocations: createMemoryRevocationStore(),
  now
})
const app = createServer(new Webhooks({ secret: 'test-secret' }), {
  modelProxy: createModelProxy({ tokens, apiKey: API_KEY, workspaceId: 'wrkspc_test' })
})

const messageBody = JSON.stringify({
  model: 'claude-opus-5-5',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }]
})

function send(headers: Record<string, string>, path = '/model-proxy/v1/messages?beta=true') {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
    payload: messageBody
  })
}

function expectKeyHidden(response: LightMyRequestResponse) {
  expect(JSON.stringify(response.headers)).not.toContain(API_KEY)
  expect(response.body).not.toContain(API_KEY)
}

beforeAll(async () => {
  anthropic = await fakeAnthropic()
})

afterAll(async () => {
  await app.close()
  await anthropic.close()
})

beforeEach(() => {
  clock = Date.UTC(2026, 8, 28)
  anthropic.reset()
})

describe('model proxy', () => {
  it('forwards a request with a valid run token using the real key', async () => {
    const { token } = tokens.issue('run-1', HOUR)
    const response = await send({
      authorization: `Bearer ${token}`,
      cookie: 'session=caller',
      'x-forwarded-for': '203.0.113.7'
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['request-id']).toBe('req_1')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.json()).toEqual({ id: 'msg_1', type: 'message' })

    expect(anthropic.calls).toHaveLength(1)
    const call = anthropic.lastCall()
    expect(call.url).toBe('/v1/messages?beta=true')
    expect(call.method).toBe('POST')
    expect(call.headers['x-api-key']).toBe(API_KEY)
    expect(call.headers['anthropic-workspace-id']).toBe('wrkspc_test')
    expect(call.headers['anthropic-version']).toBe('2023-06-01')
    expect(call.headers.authorization).toBeUndefined()
    expect(call.headers.cookie).toBeUndefined()
    expect(call.headers['x-forwarded-for']).toBeUndefined()
    expect(call.body).toBe(messageBody)
  })

  it('accepts the run token in the x-api-key header', async () => {
    const { token } = tokens.issue('run-1', HOUR)
    const response = await send({ 'x-api-key': token })

    expect(response.statusCode).toBe(200)
    expect(anthropic.lastCall().headers['x-api-key']).toBe(API_KEY)
  })

  it('passes upstream errors through unchanged', async () => {
    anthropic.respondWith((response) => {
      response.writeHead(529, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' }
        })
      )
    })
    const { token } = tokens.issue('run-1', HOUR)
    const response = await send({ authorization: `Bearer ${token}` })

    expect(response.statusCode).toBe(529)
    expect(response.json()).toEqual({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' }
    })
  })

  describe('rejects without reaching Anthropic', () => {
    it('a request without a token', async () => {
      const response = await send({})
      expect(response.statusCode).toBe(401)
      expectKeyHidden(response)
      expect(anthropic.calls).toHaveLength(0)
    })

    it('a token signed with another secret', async () => {
      const forger = createRunTokens({
        secret: 'some-other-secret-that-is-long-enough',
        revocations: createMemoryRevocationStore()
      })
      const response = await send({ authorization: `Bearer ${forger.issue('run-1', HOUR).token}` })
      expect(response.statusCode).toBe(401)
      expect(anthropic.calls).toHaveLength(0)
    })

    it('a token whose claims were altered', async () => {
      const [prefix, , signature] = tokens.issue('run-1', HOUR).token.split('.')
      const payload = Buffer.from(
        JSON.stringify({ run: 'run-2', jti: 'x', exp: clock + 100 * HOUR })
      ).toString('base64url')
      const response = await send({ authorization: `Bearer ${prefix}.${payload}.${signature}` })
      expect(response.statusCode).toBe(401)
      expect(anthropic.calls).toHaveLength(0)
    })

    it('the real API key presented as a token', async () => {
      const response = await send({ 'x-api-key': API_KEY })
      expect(response.statusCode).toBe(401)
      expectKeyHidden(response)
      expect(anthropic.calls).toHaveLength(0)
    })

    it('an expired token', async () => {
      const { token } = tokens.issue('run-1', HOUR)
      clock += HOUR
      const response = await send({ authorization: `Bearer ${token}` })
      expect(response.statusCode).toBe(401)
      expect(anthropic.calls).toHaveLength(0)
    })

    it('a revoked token', async () => {
      const { token } = tokens.issue('run-1', HOUR)
      expect((await send({ authorization: `Bearer ${token}` })).statusCode).toBe(200)

      await tokens.revoke(token)
      const response = await send({ authorization: `Bearer ${token}` })
      expect(response.statusCode).toBe(401)
      expect(anthropic.calls).toHaveLength(1)
    })

    it('a path outside the messages and models API', async () => {
      const { token } = tokens.issue('run-1', HOUR)
      const response = await send({ authorization: `Bearer ${token}` }, '/model-proxy/v1/files')
      expect(response.statusCode).toBe(404)
      expect(anthropic.calls).toHaveLength(0)
    })
  })

  it('answers a generic 502 without the key when Anthropic drops the connection', async () => {
    anthropic.respondWith((response) => response.socket?.destroy())
    const { token } = tokens.issue('run-1', HOUR)
    const response = await send({ authorization: `Bearer ${token}` })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'upstream unavailable' }
    })
    expectKeyHidden(response)
  })
})
