import { parseArgs } from 'node:util'
import { aiEnvSchema } from './env.ts'
import { fetchNpmAdvisories } from './github-advisories.ts'
import { createModel } from './model.ts'
import { triageAdvisory } from './triage.ts'

const { positionals } = parseArgs({ allowPositionals: true })
const [ghsaId, packageName] = positionals
if (!ghsaId) {
  console.error('usage: pnpm --filter agent triage <GHSA-id> [npm-package]')
  process.exit(2)
}

const model = createModel(aiEnvSchema.parse(process.env))
const advisories = (await fetchNpmAdvisories(ghsaId)).filter(
  (a) => !packageName || a.packageName === packageName
)
if (advisories.length === 0) {
  console.error(`no npm packages in ${ghsaId}${packageName ? ` named ${packageName}` : ''}`)
  process.exit(1)
}

for (const advisory of advisories) {
  const triage = await triageAdvisory(model, advisory)
  console.log(JSON.stringify({ package: advisory.packageName, ...triage }, null, 2))
}
