import { parseArgs } from 'node:util'
import { aiEnvSchema } from './env.ts'
import { fetchGlobalAdvisory } from './github-advisories.ts'
import { createModel } from './model.ts'
import { InMemoryStore } from './pipeline/memory-store.ts'
import { createPipeline } from './pipeline/pipeline.ts'

const { positionals } = parseArgs({ allowPositionals: true })
const [ghsaId, packageName] = positionals
if (!ghsaId) {
  console.error('usage: pnpm --filter agent triage <GHSA-id> [npm-package]')
  process.exit(2)
}

const store = new InMemoryStore()
const pipeline = createPipeline({
  github: {
    async getAdvisory(id) {
      const advisory = await fetchGlobalAdvisory(id)
      if (!advisory || !packageName) return advisory
      return {
        ...advisory,
        vulnerabilities: advisory.vulnerabilities.filter((v) => v.packageName === packageName)
      }
    }
  },
  fixer: { fix: () => Promise.reject(new Error('the triage CLI does not fix packages')) },
  model: createModel(aiEnvSchema.parse(process.env)),
  store,
  notifier: {
    async notify(notification) {
      console.error(`${notification.type}: ${notification.packageName}: ${notification.reason}`)
    }
  },
  clock: { now: () => new Date() }
})

await pipeline.handle({ type: 'advisory-published', ghsaId })

const runs = await store.listRuns({ ghsaId })
if (runs.length === 0) {
  console.error(`no npm packages in ${ghsaId}${packageName ? ` named ${packageName}` : ''}`)
  process.exit(1)
}

for (const run of runs) {
  const { packageName: name, state, triage, failure } = run
  console.log(JSON.stringify({ package: name, state, ...triage, failure }, null, 2))
}
if (runs.some((run) => run.state === 'failed')) process.exitCode = 1
