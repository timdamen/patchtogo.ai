import http from 'node:http'
import type { AddressInfo } from 'node:net'

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

export interface ModelRequest {
  model: string
  stream?: boolean
  system?: unknown
  messages: { role: string; content: unknown }[]
}

export type Respond = (request: ModelRequest) => Block[] | Promise<Block[]>

export interface ModelStub {
  url: string
  close: () => Promise<void>
}

export function toolResultFor(request: ModelRequest, toolUseId: string): unknown {
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as { type?: string; tool_use_id?: string }[]) {
      if (block.type === 'tool_result' && block.tool_use_id === toolUseId) return block
    }
  }
  return undefined
}

export function systemText(request: ModelRequest): string {
  return JSON.stringify(request.system ?? '')
}

function sse(response: http.ServerResponse, model: string, content: Block[]) {
  const stopReason = content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn'
  const usage = {
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  }
  const send = (type: string, data: Record<string, unknown>) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  send('message_start', {
    message: {
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage
    }
  })
  content.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } })
    } else {
      send('content_block_start', { index, content_block: { ...block, input: {} } })
      send('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      })
    }
    send('content_block_stop', { index })
  })
  send('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 1 }
  })
  send('message_stop', {})
  response.end()
}

export async function startModelStub(respond: Respond): Promise<ModelStub> {
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => (raw += chunk.toString()))
    request.on('end', async () => {
      if (!request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ input_tokens: 1 }))
        return
      }
      const body = JSON.parse(raw) as ModelRequest
      sse(response, body.model, await respond(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
