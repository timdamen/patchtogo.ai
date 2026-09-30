import { readFile, rm, writeFile } from 'node:fs/promises'
import { noUsage, runnerInputSchema, type RunnerEvent, type RunnerResult } from './protocol.ts'
import { runSession } from './session.ts'
import {
  Workspace,
  clip,
  rerunRegression,
  rerunUpstreamSuite,
  testEnv,
  testFilesInside
} from './verify.ts'

function line(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function event(name: string, detail?: string) {
  line({ type: 'ptg_runner', event: name, detail } satisfies RunnerEvent)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const inputPath = process.argv[2]
if (!inputPath) {
  console.error('usage: node src/main.ts <input.json>')
  process.exit(2)
}

const input = runnerInputSchema.parse(JSON.parse(await readFile(inputPath, 'utf8')))
const runToken = (await readFile(input.tokenPath, 'utf8')).trim()
await rm(input.tokenPath)

const workspace = new Workspace(input.workdir, testEnv(process.env), input.limits.testTimeoutMs)
let result: RunnerResult = {
  sessionId: input.session.id,
  report: null,
  error: null,
  diff: '',
  regression: null,
  upstreamTests: null,
  usage: noUsage
}

try {
  const base = await workspace.init()
  if (input.priorDiff) {
    await workspace.apply(input.priorDiff, input.scratchDir)
    event('prior-diff-applied')
  }

  event('session-start', input.session.resume ? 'resume' : 'new')
  const outcome = await runSession(input, runToken, line)
  event('session-end', outcome.error ?? undefined)
  result = { ...result, ...outcome }

  const { commit: patched, placeholders } = await workspace.snapshotSession()
  if (placeholders.length > 0) event('sandbox-placeholders-removed', placeholders.join(' '))
  result.diff = await workspace.diff(base, patched)

  if (outcome.report) {
    const { regressionTest } = outcome.report
    const testFiles = testFilesInside(input.workdir, regressionTest.files)
    event('regression-rerun')
    result.regression = await rerunRegression(
      workspace,
      { base, patched },
      regressionTest,
      testFiles
    )
    event('upstream-tests')
    result.upstreamTests = await rerunUpstreamSuite(workspace, { base, patched })
  }
} catch (error) {
  result.error = result.error ?? message(error)
}
if (result.error) result.error = clip(result.error, 4000)

await writeFile(input.resultPath, JSON.stringify(result))
event('done', result.error ?? undefined)
