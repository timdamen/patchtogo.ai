import { serve } from '@hono/node-server'
import { Webhooks } from '@octokit/webhooks'
import { aiEnvSchema, serverEnvSchema } from './env.ts'
import { createModelProxy } from './model-proxy.ts'
import { createMemoryRevocationStore, createRunTokens } from './run-tokens.ts'
import { createServer } from './server.ts'

const env = serverEnvSchema.parse(process.env)
const aiEnv = aiEnvSchema.parse(process.env)
const runTokens = createRunTokens({
  secret: env.PTG_RUN_TOKEN_SECRET,
  revocations: createMemoryRevocationStore()
})
const modelProxy = createModelProxy({
  tokens: runTokens,
  apiKey: aiEnv.ANTHROPIC_API_KEY,
  workspaceId: aiEnv.ANTHROPIC_WORKSPACE_ID
})
const webhooks = new Webhooks({ secret: env.GITHUB_WEBHOOK_SECRET })

webhooks.onAny(({ id, name }) => {
  console.log(`received ${name} (${id})`)
})

serve({ fetch: createServer(webhooks, { modelProxy }).fetch, port: env.PORT }, ({ port }) => {
  console.log(`patchtogo agent listening on :${port}`)
})
