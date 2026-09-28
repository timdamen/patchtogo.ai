import { setTimeout as sleep } from 'node:timers/promises'
import { serve } from '@hono/node-server'
import { Webhooks } from '@octokit/webhooks'
import { createAdvisoryPoller } from './advisory-poller.ts'
import { forwardSecurityAdvisories } from './advisory-webhook.ts'
import { aiEnvSchema, serverEnvSchema } from './env.ts'
import { fetchGlobalAdvisory, npmAdvisoriesUpdatedSince } from './github-advisories.ts'
import { createModel } from './model.ts'
import { createModelProxy } from './model-proxy.ts'
import { consoleNotifier, createDiscordNotifier } from './notifier.ts'
import { IllegalTransitionError } from './pipeline/patch-run.ts'
import { createPipeline } from './pipeline/pipeline.ts'
import { openPostgres } from './postgres/connect.ts'
import { createPgPollCursor } from './postgres/poll-cursor.ts'
import { createPgRevocationStore } from './postgres/revocations.ts'
import { PostgresStore } from './postgres/store.ts'
import { createPipelineQueue } from './queue.ts'
import { createRunTokens } from './run-tokens.ts'
import { createServer } from './server.ts'

const env = serverEnvSchema.parse(process.env)
const aiEnv = aiEnvSchema.parse(process.env)
const githubApi = { token: env.GITHUB_TOKEN }

const postgres = await openPostgres(env.DATABASE_URL, { maintenance: true })
const queue = await createPipelineQueue(postgres.boss, {
  concurrency: env.PTG_MAX_CONCURRENT_RUNS,
  timeoutSeconds: env.PTG_JOB_TIMEOUT_MINUTES * 60
})

const runTokens = createRunTokens({
  secret: env.PTG_RUN_TOKEN_SECRET,
  revocations: createPgRevocationStore(postgres.db)
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
  store: new PostgresStore(postgres.db),
  notifier: env.DISCORD_WEBHOOK_URL
    ? createDiscordNotifier({ webhookUrl: env.DISCORD_WEBHOOK_URL })
    : consoleNotifier,
  clock: { now: () => new Date() }
})

await queue.work(async (event) => {
  try {
    await pipeline.handle(event)
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) throw error
    console.warn(`dropped ${JSON.stringify(event)}: ${error.message}`)
  }
})

const webhooks = new Webhooks({ secret: env.GITHUB_WEBHOOK_SECRET })
webhooks.onAny(({ id, name }) => {
  console.log(`received ${name} (${id})`)
})
forwardSecurityAdvisories(webhooks, queue.send)

const poller = createAdvisoryPoller({
  updatedSince: (since) => npmAdvisoriesUpdatedSince(since, githubApi),
  cursor: createPgPollCursor(postgres.db, {
    name: 'github-advisories',
    initial: () => new Date(Date.now() - env.PTG_POLL_LOOKBACK_HOURS * 3_600_000)
  }),
  emit: queue.send
})

const polling = new AbortController()

async function pollAdvisories(): Promise<void> {
  while (!polling.signal.aborted) {
    try {
      console.log(`advisory poll: ${await poller.poll()} advisories`)
    } catch (error) {
      console.error('advisory poll failed', error)
    }
    await sleep(env.PTG_POLL_INTERVAL_MINUTES * 60_000, undefined, {
      signal: polling.signal
    }).catch(() => undefined)
  }
}

const server = serve(
  { fetch: createServer(webhooks, { modelProxy }).fetch, port: env.PORT },
  ({ port }) => {
    console.log(
      `patchtogo agent listening on :${port}, running at most ${env.PTG_MAX_CONCURRENT_RUNS} patch runs at once`
    )
  }
)
void pollAdvisories()

async function shutdown(signal: string) {
  console.log(`${signal}: shutting down`)
  polling.abort()
  server.close()
  await postgres.close({ graceful: true, timeoutMs: 20_000 })
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
