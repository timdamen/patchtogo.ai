import { serve } from '@hono/node-server'
import { Webhooks } from '@octokit/webhooks'
import { serverEnvSchema } from './env.ts'
import { createServer } from './server.ts'

const env = serverEnvSchema.parse(process.env)
const webhooks = new Webhooks({ secret: env.GITHUB_WEBHOOK_SECRET })

webhooks.onAny(({ id, name }) => {
  console.log(`received ${name} (${id})`)
})

serve({ fetch: createServer(webhooks).fetch, port: env.PORT }, ({ port }) => {
  console.log(`patchtogo agent listening on :${port}`)
})
