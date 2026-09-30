import { readFile } from 'node:fs/promises'
import { text } from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import { databaseEnvSchema, pipelineEnvSchema, serverEnvSchema } from './env.ts'
import { injectTestAdvisory } from './operator.ts'
import { openPostgres } from './postgres/connect.ts'
import { PostgresStore } from './postgres/store.ts'
import { createPipelineQueue } from './queue.ts'

const { positionals } = parseArgs({ allowPositionals: true })
if (positionals.length !== 1) {
  console.error('usage: pnpm --filter agent test-advisory <advisory.json | ->')
  process.exit(2)
}
const [source = '-'] = positionals

const { DATABASE_URL } = databaseEnvSchema.parse(process.env)
const { PTG_AUTOMATION_PACKAGES } = pipelineEnvSchema.parse(process.env)
const { PTG_MAX_CONCURRENT_RUNS, PTG_JOB_TIMEOUT_MINUTES } = serverEnvSchema
  .pick({ PTG_MAX_CONCURRENT_RUNS: true, PTG_JOB_TIMEOUT_MINUTES: true })
  .parse(process.env)

const raw: unknown = JSON.parse(
  source === '-' ? await text(process.stdin) : await readFile(source, 'utf8')
)

const postgres = await openPostgres(DATABASE_URL, { maintenance: false })
try {
  const queue = await createPipelineQueue(postgres.boss, {
    concurrency: PTG_MAX_CONCURRENT_RUNS,
    timeoutSeconds: PTG_JOB_TIMEOUT_MINUTES * 60
  })
  const ghsaId = await injectTestAdvisory(raw, PTG_AUTOMATION_PACKAGES, {
    store: new PostgresStore(postgres.db),
    queue
  })
  console.log(`stored the test advisory ${ghsaId} and queued its advisory-published event`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await postgres.close({ graceful: false })
}
