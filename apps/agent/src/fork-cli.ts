import { parseArgs } from 'node:util'
import { createSandboxBuilder } from './builder/sandbox-builder.ts'
import { fixerEnvSchema, githubAppEnvSchema, pipelineEnvSchema } from './env.ts'
import { fixerSettings } from './fixer/config.ts'
import { createGitHubApp, installationOctokit } from './github-app.ts'
import { createNpmRegistry } from './npm-registry.ts'
import { InMemoryStore } from './pipeline/memory-store.ts'
import { newPatchRun } from './pipeline/patch-run.ts'
import { createPipeline } from './pipeline/pipeline.ts'
import { consoleNotifier } from './notifier.ts'

const usage = [
  'usage: pnpm --filter agent fork <npm-package> [--range <vulnerable range>]',
  'Forks the package into PTG_FORK_ORG, runs the tarball-match check in a Vercel Sandbox and',
  'cuts the scaffolded base branch, as a "patch" triage would. This creates real repositories.'
].join('\n')

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    range: { type: 'string', default: '*' },
    help: { type: 'boolean', default: false }
  }
})
const [packageName] = positionals
if (values.help || !packageName) {
  console.log(usage)
  process.exit(values.help ? 0 : 2)
}

const settings = pipelineEnvSchema.parse(process.env)
const github = createGitHubApp(
  await installationOctokit(githubAppEnvSchema.parse(process.env), settings.PTG_FORK_ORG)
)
const advisory = {
  ghsaId: 'GHSA-ptg0-fork-cli0',
  cveId: null,
  packageName,
  vulnerableRange: values.range,
  patchedVersion: null,
  severity: 'low' as const,
  summary: `Fork check for ${packageName}`,
  description: 'Started from the fork CLI.'
}
const store = new InMemoryStore()
await store.createRunIfAbsent({
  ...newPatchRun(advisory, new Date()),
  state: 'triaged',
  triage: {
    decision: 'patch',
    reason: 'Started from the fork CLI.',
    suspectedFiles: [],
    fixStrategy: ''
  }
})

const pipeline = createPipeline(
  {
    github: {
      ...github,
      getAdvisory: async (ghsaId) => ({
        ghsaId,
        cveId: null,
        summary: advisory.summary,
        description: advisory.description,
        severity: advisory.severity,
        vulnerabilities: [
          {
            ecosystem: 'npm',
            packageName,
            vulnerableRange: values.range,
            patchedVersion: null
          }
        ]
      })
    },
    registry: createNpmRegistry(),
    builder: createSandboxBuilder({
      credentials: fixerSettings(fixerEnvSchema.parse(process.env)).credentials,
      sourceArchive: github.sourceArchive
    }),
    fixer: { fix: () => Promise.reject(new Error('the fork CLI does not fix packages')) },
    modelAccess: {
      grant: () => Promise.reject(new Error('the fork CLI does not grant model access'))
    },
    model: 'triage-is-skipped',
    store,
    notifier: consoleNotifier,
    clock: { now: () => new Date() }
  },
  {
    forkOrg: settings.PTG_FORK_ORG,
    npmScope: settings.PTG_NPM_SCOPE,
    reviewerTeam: settings.PTG_REVIEWER_TEAM,
    automation: 'fork'
  }
)

await pipeline.handle({ type: 'advisory-published', ghsaId: advisory.ghsaId })

const [run] = await store.listRuns()
const { state, reason, failure, release, fork, baseBranch } = run ?? {}
console.log(JSON.stringify({ state, reason, failure, release, fork, baseBranch }, null, 2))
for (const cost of run ? await store.listCosts(run.id) : []) {
  console.log(`${cost.step}: ${cost.sandboxSeconds} s in the sandbox`)
}
if (state !== 'fixing') process.exitCode = 1
