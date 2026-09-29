import { setTimeout as sleep } from 'node:timers/promises'
import { serve } from '@hono/node-server'
import { Webhooks } from '@octokit/webhooks'
import { createAdvisoryPoller } from './advisory-poller.ts'
import { forwardSecurityAdvisories } from './advisory-webhook.ts'
import { createSandboxBuilder } from './builder/sandbox-builder.ts'
import {
  aiEnvSchema,
  fixerEnvSchema,
  githubAppEnvSchema,
  pipelineEnvSchema,
  serverEnvSchema
} from './env.ts'
import { fixerSettings } from './fixer/config.ts'
import { describeLine } from './fixer/runner-lines.ts'
import { createSandboxFixer, modelTokenTtlMs } from './fixer/sandbox-fixer.ts'
import { npmAdvisoriesUpdatedSince } from './github-advisories.ts'
import { createGitHubApp, installationOctokit } from './github-app.ts'
import { createModel } from './model.ts'
import { createModelProxy } from './model-proxy.ts'
import { createNpmRegistry } from './npm-registry.ts'
import { consoleNotifier, createDiscordNotifier } from './notifier.ts'
import { IllegalTransitionError } from './pipeline/patch-run.ts'
import { createPipeline } from './pipeline/pipeline.ts'
import { openPostgres } from './postgres/connect.ts'
import { createPgPollCursor } from './postgres/poll-cursor.ts'
import { createPgRevocationStore } from './postgres/revocations.ts'
import { PostgresStore } from './postgres/store.ts'
import { createPipelineQueue } from './queue.ts'
import type { Fixer } from './pipeline/ports.ts'
import { createRunTokens, runTokenAccess } from './run-tokens.ts'
import { createServer } from './server.ts'

const env = serverEnvSchema.parse(process.env)
const aiEnv = aiEnvSchema.parse(process.env)
const pipelineEnv = pipelineEnvSchema.parse(process.env)
const fixerEnv = fixerEnvSchema.parse(process.env)
const fixerConfig = fixerSettings(fixerEnv)
if (pipelineEnv.PTG_AUTOMATION === 'full' && !fixerEnv.PTG_MODEL_PROXY_URL) {
  throw new Error('PTG_AUTOMATION=full needs PTG_MODEL_PROXY_URL for the fixer')
}
const githubApi = { token: env.GITHUB_TOKEN }
const github = createGitHubApp(
  await installationOctokit(githubAppEnvSchema.parse(process.env), pipelineEnv.PTG_FORK_ORG)
)

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

const fixer: Fixer = fixerEnv.PTG_MODEL_PROXY_URL
  ? createSandboxFixer({
      ...fixerConfig,
      proxyBaseUrl: fixerEnv.PTG_MODEL_PROXY_URL,
      sourceArchive: github.sourceArchive,
      onLine(line) {
        const text = describeLine(line)
        if (text) console.log(`fixer: ${text}`)
      }
    })
  : { fix: () => Promise.reject(new Error('PTG_MODEL_PROXY_URL is not set')) }

const pipeline = createPipeline(
  {
    github,
    registry: createNpmRegistry(),
    builder: createSandboxBuilder({
      credentials: fixerConfig.credentials,
      sourceArchive: github.sourceArchive
    }),
    fixer,
    modelAccess: runTokenAccess(runTokens, modelTokenTtlMs(fixerConfig.limits)),
    model: createModel(aiEnv),
    store: new PostgresStore(postgres.db),
    notifier: env.DISCORD_WEBHOOK_URL
      ? createDiscordNotifier({ webhookUrl: env.DISCORD_WEBHOOK_URL })
      : consoleNotifier,
    clock: { now: () => new Date() }
  },
  {
    forkOrg: pipelineEnv.PTG_FORK_ORG,
    npmScope: pipelineEnv.PTG_NPM_SCOPE,
    reviewerTeam: pipelineEnv.PTG_REVIEWER_TEAM,
    automation: pipelineEnv.PTG_AUTOMATION
  }
)

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
      `patchtogo agent listening on :${port}, automation ${pipelineEnv.PTG_AUTOMATION}, running at most ${env.PTG_MAX_CONCURRENT_RUNS} patch runs at once`
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
