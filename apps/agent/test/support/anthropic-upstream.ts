import { once } from 'node:events'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

const ANTHROPIC_ORIGIN = 'https://api.anthropic.com'

export interface UpstreamCall {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

type Respond = (response: ServerResponse, request: IncomingMessage) => void

export interface FakeAnthropic {
  calls: UpstreamCall[]
  respondWith(respond: Respond): void
  reset(): void
  lastCall(): UpstreamCall
  close(): Promise<void>
}

function answerWithMessage(response: ServerResponse) {
  response.writeHead(200, {
    'content-type': 'application/json',
    'request-id': 'req_1',
    'set-cookie': 'upstream=1'
  })
  response.end(JSON.stringify({ id: 'msg_1', type: 'message' }))
}

export async function fakeAnthropic(): Promise<FakeAnthropic> {
  const calls: UpstreamCall[] = []
  let respond: Respond = answerWithMessage

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    calls.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body: Buffer.concat(chunks).toString()
    })
    respond(response, request)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const previous = getGlobalDispatcher()
  const agent = new Agent()
  setGlobalDispatcher(
    agent.compose(
      (dispatch) => (options, handler) =>
        dispatch(
          new URL(String(options.origin)).origin === ANTHROPIC_ORIGIN
            ? { ...options, origin }
            : options,
          handler
        )
    )
  )

  return {
    calls,
    respondWith(next) {
      respond = next
    },
    reset() {
      calls.length = 0
      respond = answerWithMessage
    },
    lastCall() {
      const call = calls.at(-1)
      if (!call) throw new Error('Anthropic was never called')
      return call
    },
    async close() {
      setGlobalDispatcher(previous)
      await agent.destroy()
      server.closeAllConnections()
      server.close()
    }
  }
}
