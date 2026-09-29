import { parseArgs } from 'node:util'
import { databaseEnvSchema, serverEnvSchema } from './env.ts'
import { listFailures, requestRetry } from './operator.ts'
import { openPostgres } from './postgres/connect.ts'
import { PostgresStore } from './postgres/store.ts'
import { createPipelineQueue } from './queue.ts'

const { positionals } = parseArgs({ allowPositionals: true })
if (positionals.length > 1) {
  console.error('usage: pnpm --filter agent retry [<GHSA-id> | <GHSA-id>:<npm-package>]')
  process.exit(2)
}
const [target] = positionals

const { DATABASE_URL } = databaseEnvSchema.parse(process.env)
const { PTG_MAX_CONCURRENT_RUNS, PTG_JOB_TIMEOUT_MINUTES } = serverEnvSchema
  .pick({ PTG_MAX_CONCURRENT_RUNS: true, PTG_JOB_TIMEOUT_MINUTES: true })
  .parse(process.env)

const postgres = await openPostgres(DATABASE_URL, { maintenance: false })
try {
  const store = new PostgresStore(postgres.db)
  const queue = await createPipelineQueue(postgres.boss, {
    concurrency: PTG_MAX_CONCURRENT_RUNS,
    timeoutSeconds: PTG_JOB_TIMEOUT_MINUTES * 60
  })

  if (!target) {
    const { runs, blockedAdvisories } = await listFailures({ store, queue })
    for (const run of runs) {
      console.log(`${run.id}\tfailed at ${run.failure?.step}: ${run.failure?.error}`)
    }
    for (const ghsaId of blockedAdvisories) {
      console.log(`${ghsaId}\tqueue job failed, later events for it wait`)
    }
    if (runs.length === 0 && blockedAdvisories.length === 0) console.log('nothing has failed')
  } else {
    const { retriedJobs, retriedRuns } = await requestRetry(target, { store, queue })
    for (const runId of retriedRuns) console.log(`queued a retry of ${runId}`)
    if (retriedJobs > 0) console.log(`re-queued ${retriedJobs} failed job(s) for ${target}`)
    if (retriedRuns.length === 0 && retriedJobs === 0) {
      console.error(`nothing to retry for ${target}: no failed or held run and no failed queue job`)
      process.exitCode = 1
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await postgres.close({ graceful: false })
}
