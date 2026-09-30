import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { request } from 'undici'
import { describe, expect, it } from 'vitest'

const agentDir = fileURLToPath(new URL('..', import.meta.url))
const source = (file: string) =>
  JSON.stringify(fileURLToPath(new URL(`../src/${file}`, import.meta.url)))

function startProcess(script: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: agentDir,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  let waiters: Array<{ pattern: RegExp; resolve: (match: RegExpMatchArray) => void }> = []
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
    waiters = waiters.filter((waiter) => {
      const match = stdout.match(waiter.pattern)
      if (match) waiter.resolve(match)
      return !match
    })
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  const exited = once(child, 'exit').then(([code]) => code as number | null)

  return {
    child,
    exited,
    output: () => ({ stdout, stderr }),
    waitFor(pattern: RegExp) {
      const match = stdout.match(pattern)
      if (match) return Promise.resolve(match)
      return new Promise<RegExpMatchArray>((resolve) => waiters.push({ pattern, resolve }))
    }
  }
}

function gracefulExitScript(options: { close: string; trigger?: string }) {
  return `
    import { exitGracefully } from ${source('shutdown.ts')}
    exitGracefully({
      deadlineMs: 300,
      log: { info: (message) => console.log(message), error: (_details, message) => console.error(message) },
      close: async () => { ${options.close} }
    })
    setInterval(() => {}, 1000)
    console.log('ready')
    ${options.trigger ?? ''}
  `
}

describe('the service process', () => {
  it('closes and exits 0 on SIGTERM', async () => {
    const service = startProcess(
      gracefulExitScript({
        close: `await new Promise((resolve) => setTimeout(resolve, 50)); console.log('closed')`
      })
    )
    await service.waitFor(/ready/)

    service.child.kill('SIGTERM')

    expect(await service.exited).toBe(0)
    expect(service.output().stdout).toContain('closed')
  })

  it('exits 1 when closing misses the deadline', async () => {
    const service = startProcess(gracefulExitScript({ close: 'await new Promise(() => {})' }))
    await service.waitFor(/ready/)

    service.child.kill('SIGTERM')

    expect(await service.exited).toBe(1)
    expect(service.output().stderr).toContain('missed its deadline')
  })

  it.each([
    { crash: 'an uncaught exception', trigger: `setTimeout(() => { throw new Error('boom') })` },
    { crash: 'an unhandled rejection', trigger: `void Promise.reject(new Error('boom'))` }
  ])('logs $crash, closes and exits 1', async ({ trigger }) => {
    const service = startProcess(gracefulExitScript({ close: `console.log('closed')`, trigger }))

    expect(await service.exited).toBe(1)
    expect(service.output().stdout).toContain('closed')
    expect(service.output().stderr).toMatch(/uncaught exception|unhandled rejection/)
  })

  it('logs requests without their credentials or signatures', async () => {
    const service = startProcess(`
      import { Webhooks } from '@octokit/webhooks'
      import { createModelProxy } from ${source('model-proxy.ts')}
      import { createMemoryRevocationStore, createRunTokens } from ${source('run-tokens.ts')}
      import { createServer } from ${source('server.ts')}
      const tokens = createRunTokens({
        secret: 'a-run-token-secret-that-is-long-enough',
        revocations: createMemoryRevocationStore()
      })
      const server = createServer(new Webhooks({ secret: 'test-secret' }), {
        logger: true,
        modelProxy: createModelProxy({ tokens, apiKey: 'sk-ant-real-key' })
      })
      await server.listen({ port: 0, host: '127.0.0.1' })
    `)
    const [, origin] = await service.waitFor(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)
    const signature = `sha256=${'ab'.repeat(32)}`

    try {
      const webhook = await request(`${origin}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-delivery': 'delivery-logged',
          'x-github-event': 'ping',
          'x-hub-signature-256': signature
        },
        body: '{}'
      })
      await webhook.body.dump()
      const proxied = await request(`${origin}/model-proxy/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer run-token-from-the-sandbox',
          'x-api-key': 'api-key-from-the-sandbox'
        },
        body: '{}'
      })
      await proxied.body.dump()
      await service.waitFor(/"statusCode":401[^]*"statusCode":401/)
    } finally {
      service.child.kill('SIGKILL')
    }

    const { stdout } = service.output()
    expect(stdout).toContain('delivery-logged')
    expect(stdout).toContain('/model-proxy/v1/messages')
    expect(stdout).not.toContain(signature)
    expect(stdout).not.toContain('run-token-from-the-sandbox')
    expect(stdout).not.toContain('api-key-from-the-sandbox')
  })
})
