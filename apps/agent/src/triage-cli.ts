import { parseArgs } from 'node:util'
import { npmAdvisories } from './advisory.ts'
import { aiEnvSchema } from './env.ts'
import { fetchGlobalAdvisory } from './github-advisories.ts'
import { createModel } from './model.ts'
import { triageAdvisory } from './triage.ts'

const { positionals } = parseArgs({ allowPositionals: true })
const [ghsaId, packageName] = positionals
if (!ghsaId) {
  console.error('usage: pnpm --filter agent triage <GHSA-id> [npm-package]')
  process.exit(2)
}

const advisory = await fetchGlobalAdvisory(ghsaId)
const packages = (advisory ? npmAdvisories(advisory) : []).filter(
  (entry) => !packageName || entry.packageName === packageName
)
if (packages.length === 0) {
  console.error(`no npm packages in ${ghsaId}${packageName ? ` named ${packageName}` : ''}`)
  process.exit(1)
}

const model = createModel(aiEnvSchema.parse(process.env))
for (const entry of packages) {
  try {
    const { triage } = await triageAdvisory(model, entry)
    console.log(JSON.stringify({ package: entry.packageName, ...triage }, null, 2))
  } catch (error) {
    process.exitCode = 1
    const message = error instanceof Error ? error.message : String(error)
    console.log(JSON.stringify({ package: entry.packageName, failure: message }, null, 2))
  }
}
