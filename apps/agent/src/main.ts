import { setTimeout as sleep } from 'node:timers/promises'
import { serve } from '@hono/node-server'
import { Webhooks } from '@octokit/webhooks'
import { createAdvisoryPoller, InMemoryPollCursor } from './advisory-poller.ts'
import { forwardSecurityAdvisories } from './advisory-webhook.ts'
import { aiEnvSchema, serverEnvSchema } from './env.ts'
import { fetchGlobalAdvisory, npmAdvisoriesUpdatedSince } from './github-advisories.ts'
import { createModel } from './model.ts'
import { createModelProxy } from './model-proxy.ts'
import type { PipelineEvent } from './pipeline/events.ts'
import { InMemoryStore } from './pipeline/memory-store.ts'
import { createPipeline } from './pipeline/pipeline.ts'
import { createMemoryRevocationStore, createRunTokens } from './run-tokens.ts'
import { createServer } from './server.ts'

const env = serverEnvSchema.parse(process.env)
const aiEnv = aiEnvSchema.parse(process.env)
const githubApi = { token: env.GITHUB_TOKEN }

const runTokens = createRunTokens({
  secret: env.PTG_RUN_TOKEN_SECRET,
  revocations: createMemoryRevocationStore()
})
const modelProxy = createModelProxy({
  tokens: runTokens,
  apiKey: aiEnv.ANTHROPIC_API_KEY,
  workspaceId: aiEnv.ANTHROPIC_WORKSPACE_ID
})

const pipeline = createPipeline({
  github: { getAdvisory: (ghsaId) => fetchGlobalAdvisory(ghsaId, githubApi) },
  fixer: { fix: () => Promise.reject(new Error('no fixer is configured yet')) },
  model: createModel(aiEnv),
  store: new InMemoryStore(),
  notifier: {
    async notify(notification) {
      console.log(`${notification.type}: ${notification.ghsaId} ${notification.packageName}`)
    }
  },
  clock: { now: () => new Date() }
})

let pipelineQueue = Promise.resolve()
function dispatch(event: PipelineEvent): Promise<void> {
  pipelineQueue = pipelineQueue
    .then(() => pipeline.handle(event))
    .catch((error: unknown) => console.error(`pipeline ${JSON.stringify(event)} failed`, error))
  return Promise.resolve()
}

const webhooks = new Webhooks({ secret: env.GITHUB_WEBHOOK_SECRET })
webhooks.onAny(({ id, name }) => {
  console.log(`received ${name} (${id})`)
})
forwardSecurityAdvisories(webhooks, dispatch)

const poller = createAdvisoryPoller({
  updatedSince: (since) => npmAdvisoriesUpdatedSince(since, githubApi),
  cursor: new InMemoryPollCursor(new Date(Date.now() - env.PTG_POLL_LOOKBACK_HOURS * 3_600_000)),
  emit: dispatch
})

async function pollAdvisories(): Promise<never> {
  for (;;) {
    try {
      console.log(`advisory poll: ${await poller.poll()} advisories`)
    } catch (error) {
      console.error('advisory poll failed', error)
    }
    await sleep(env.PTG_POLL_INTERVAL_MINUTES * 60_000)
  }
}

serve({ fetch: createServer(webhooks, { modelProxy }).fetch, port: env.PORT }, ({ port }) => {
  console.log(`patchtogo agent listening on :${port}`)
})
void pollAdvisories()
