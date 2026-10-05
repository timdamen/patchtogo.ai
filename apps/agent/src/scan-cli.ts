import { aiEnvSchema } from './env.ts'
import { fetchWatchedAdvisories } from './github-advisories.ts'
import { createModel } from './model.ts'
import { triageAdvisory } from './triage.ts'
import { watchlist } from './watchlist.ts'

const model = createModel(aiEnvSchema.parse(process.env))

for (const packageName of watchlist) {
  const advisories = await fetchWatchedAdvisories(packageName)
  console.log(`${packageName}: ${advisories.length} advisories`)
  for (const advisory of advisories) {
    const triage = await triageAdvisory(model, advisory)
    console.log(
      JSON.stringify({ package: packageName, ghsaId: advisory.ghsaId, ...triage }, null, 2)
    )
  }
}
