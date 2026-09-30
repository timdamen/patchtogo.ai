import { parseArgs } from 'node:util'
import { npmAdvisories } from './advisory.ts'
import { aiEnvSchema } from './env.ts'
import { fetchGlobalAdvisory } from './github-advisories.ts'
import { createModel } from './model.ts'
import { createNpmRegistry } from './npm-registry.ts'
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
if (advisory?.type === 'malware') {
  console.error(`${ghsaId} is a malware advisory; malware is never a patch candidate`)
  process.exit(1)
}
if (packages.length === 0) {
  console.error(`no npm packages in ${ghsaId}${packageName ? ` named ${packageName}` : ''}`)
  process.exit(1)
}

const ports = { model: createModel(aiEnvSchema.parse(process.env)), registry: createNpmRegistry() }
for (const entry of packages) {
  try {
    const { triage } = await triageAdvisory(ports, entry)
    console.log(JSON.stringify({ package: entry.packageName, ...triage }, null, 2))
  } catch (error) {
    process.exitCode = 1
    const message = error instanceof Error ? error.message : String(error)
    console.log(JSON.stringify({ package: entry.packageName, failure: message }, null, 2))
  }
}
