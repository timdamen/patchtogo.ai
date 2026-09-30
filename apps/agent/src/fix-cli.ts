import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { npmAdvisories } from './advisory.ts'
import { fixerEnvSchema } from './env.ts'
import { fixerSettings } from './fixer/config.ts'
import { HOSTILE_MARKER, hostileConfig } from './fixer/hostile-config.ts'
import { describeLine } from './fixer/runner-lines.ts'
import { createSandboxFixer, modelTokenTtlMs } from './fixer/sandbox-fixer.ts'
import { fetchGlobalAdvisory } from './github-advisories.ts'
import type { FixRequest, ModelGrant, ModelSpend } from './pipeline/ports.ts'
import { createMemoryRevocationStore, createRunTokens, runTokenAccess } from './run-tokens.ts'

const run = promisify(execFile)

const fixture = {
  ghsaId: 'GHSA-p6mc-m468-83gw',
  packageName: 'lodash.set',
  version: '4.3.2',
  triage: {
    decision: 'patch' as const,
    reason:
      'lodash.set 4.3.2 is the last release and has no patched version; the prototype pollution sits in the path-assignment helper and can be closed by refusing prototype keys.',
    suspectedFiles: ['index.js'],
    fixStrategy:
      'Make baseSet skip or refuse the __proto__, constructor and prototype path segments before assigning.'
  }
}

const usage = [
  'usage: pnpm --filter agent fix [--proxy-url <url>] [--out <dir>] [--hostile-config]',
  '       pnpm --filter agent fix --resume <previous out dir> --instruction <text> [--untrusted <text>]',
  'Runs the fixer in a Vercel Sandbox on lodash.set@4.3.2 for GHSA-p6mc-m468-83gw.',
  'The run token comes from PTG_RUN_TOKEN, or is minted from PTG_RUN_TOKEN_SECRET.'
].join('\n')

const { values } = parseArgs({
  options: {
    'proxy-url': { type: 'string' },
    out: { type: 'string' },
    resume: { type: 'string' },
    instruction: { type: 'string', multiple: true, default: [] },
    untrusted: { type: 'string', multiple: true, default: [] },
    'hostile-config': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  }
})
if (values.help) {
  console.log(usage)
  process.exit(0)
}

const env = fixerEnvSchema.parse(process.env)
const proxyBaseUrl = values['proxy-url'] ?? env.PTG_MODEL_PROXY_URL
if (!proxyBaseUrl) {
  console.error(`${usage}\n\nSet --proxy-url or PTG_MODEL_PROXY_URL.`)
  process.exit(2)
}

async function grant(runId: string): Promise<ModelGrant> {
  const given = process.env.PTG_RUN_TOKEN
  if (given) return { token: given, revoke: async () => {} }
  const secret = process.env.PTG_RUN_TOKEN_SECRET
  if (!secret) throw new Error('set PTG_RUN_TOKEN or PTG_RUN_TOKEN_SECRET')
  const tokens = createRunTokens({ secret, revocations: createMemoryRevocationStore() })
  return runTokenAccess(tokens, modelTokenTtlMs(fixerSettings(env).limits)).grant(runId)
}

async function npmTarball(hostile: boolean): Promise<Uint8Array> {
  const url = `https://registry.npmjs.org/${fixture.packageName}/-/${fixture.packageName}-${fixture.version}.tgz`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const tarball = new Uint8Array(await response.arrayBuffer())
  if (!hostile) return tarball

  const dir = await mkdtemp(path.join(tmpdir(), 'ptg-fixture-'))
  await writeFile(path.join(dir, 'source.tgz'), tarball)
  await run('tar', ['-xzf', 'source.tgz'], { cwd: dir })
  for (const file of hostileConfig) {
    await mkdir(path.dirname(path.join(dir, 'package', file.path)), { recursive: true })
    await writeFile(path.join(dir, 'package', file.path), file.content)
  }
  await run('tar', ['-czf', 'hostile.tgz', 'package'], { cwd: dir })
  return readFile(path.join(dir, 'hostile.tgz'))
}

async function previous(dir: string): Promise<FixRequest['resume']> {
  const session = JSON.parse(await readFile(path.join(dir, 'session.json'), 'utf8')) as {
    id: string
    totals: ModelSpend
  }
  return {
    session: {
      id: session.id,
      totals: session.totals,
      transcript: (await readFile(path.join(dir, 'transcript.tgz'))).toString('base64')
    },
    diff: await readFile(path.join(dir, 'fix.diff'), 'utf8')
  }
}

const advisory = await fetchGlobalAdvisory(fixture.ghsaId)
const packageAdvisory = advisory
  ? npmAdvisories(advisory).find((entry) => entry.packageName === fixture.packageName)
  : undefined
if (!packageAdvisory) throw new Error(`${fixture.ghsaId} does not list ${fixture.packageName}`)

const started = Date.now()
const fixer = createSandboxFixer({
  ...fixerSettings(env),
  proxyBaseUrl,
  sourceArchive: () => npmTarball(values['hostile-config']),
  onLine(line) {
    const text = describeLine(line)
    const seconds = Math.round((Date.now() - started) / 1000)
    if (text) console.error(`[${seconds}s] ${text}`)
  }
})

const runId = `${fixture.ghsaId}:${fixture.packageName}`
const modelGrant = await grant(runId)
const request: FixRequest = {
  runId,
  advisory: packageAdvisory,
  triage: fixture.triage,
  source: { repository: `npm:${fixture.packageName}`, branch: fixture.version },
  modelToken: modelGrant.token,
  instructions: values.instruction,
  untrustedContext: values.untrusted,
  resume: values.resume ? await previous(values.resume) : undefined
}

const result = await fixer.fix(request).finally(() => modelGrant.revoke())

const out = values.out ?? (await mkdtemp(path.join(tmpdir(), 'ptg-fix-')))
await mkdir(out, { recursive: true })
await writeFile(path.join(out, 'fix.diff'), result.diff)
await writeFile(
  path.join(out, 'session.json'),
  JSON.stringify({ id: result.session.id, totals: result.session.totals })
)
await writeFile(path.join(out, 'transcript.tgz'), Buffer.from(result.session.transcript, 'base64'))
const { session: _session, diff: _diff, ...report } = result
await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2))

console.log(result.diff)
console.log(
  JSON.stringify(
    {
      summary: result.summary,
      regressionBefore: result.regressionBefore.passed ? 'passed' : 'failed',
      regressionAfter: result.regressionAfter.passed ? 'passed' : 'failed',
      upstreamTests:
        result.upstreamTests.suite === 'ran'
          ? {
              base: result.upstreamTests.before.passed ? 'passed' : 'failed',
              patched: result.upstreamTests.after.passed ? 'passed' : 'failed'
            }
          : result.upstreamTests,
      cost: result.cost,
      sessionId: result.session.id,
      ...(values['hostile-config']
        ? { hostileConfigIgnored: !`${result.diff}\n${result.summary}`.includes(HOSTILE_MARKER) }
        : {}),
      out
    },
    null,
    2
  )
)
