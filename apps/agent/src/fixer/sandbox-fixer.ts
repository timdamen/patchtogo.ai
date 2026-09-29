import { randomUUID } from 'node:crypto'
import {
  runnerResultSchema,
  type RunnerInput,
  type RunnerResult,
  type TestRun
} from '@patchtogo/fixer-runner/protocol'
import type { NetworkPolicy, Sandbox } from '@vercel/sandbox'
import type { FixRequest, FixResult, Fixer, ModelSpend, TestResult } from '../pipeline/ports.ts'
import {
  check,
  NPM_REGISTRY,
  openSandbox,
  type SandboxCredentials,
  type SourceArchive
} from '../sandbox.ts'
import { lineSplitter, parseRunnerLine, type RunnerLine } from './runner-lines.ts'
import { runnerPackage } from './runner-package.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export const sandboxLayout = {
  root: '/vercel/ptg',
  runner: '/vercel/ptg/runner',
  work: '/vercel/ptg/work',
  io: '/vercel/ptg/io',
  claude: '/vercel/ptg/claude',
  transcripts: '/vercel/ptg/claude/projects/run'
} as const

const files = {
  input: `${sandboxLayout.io}/input.json`,
  token: `${sandboxLayout.io}/token`,
  result: `${sandboxLayout.io}/result.json`,
  source: `${sandboxLayout.io}/source.tgz`,
  transcript: `${sandboxLayout.io}/transcript.tgz`
}

const bashSandboxSetup = [
  'apt-get update -qq',
  'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends bubblewrap socat',
  'umount /proc/kcore /proc/keys'
].join(' && ')

export const runnerCommand = {
  cmd: 'setpriv',
  args: [
    '--no-new-privs',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--bounding-set=-all',
    'node',
    `${sandboxLayout.runner}/src/main.ts`,
    files.input
  ]
}

export interface FixerLimits {
  maxTurns: number
  maxBudgetUsd: number
  testTimeoutMs: number
  sandboxTimeoutMs: number
}

export interface SandboxFixerOptions {
  credentials?: SandboxCredentials
  proxyBaseUrl: string
  sourceArchive: SourceArchive
  models: RunnerInput['models']
  limits: FixerLimits
  vcpus?: number
  now?: () => Date
  onLine?: (line: RunnerLine) => void
}

export function modelTokenTtlMs(limits: Pick<FixerLimits, 'sandboxTimeoutMs'>): number {
  return limits.sandboxTimeoutMs + 5 * 60_000
}

export function egressPolicy(proxyBaseUrl: string): NetworkPolicy {
  return { allow: [new URL(proxyBaseUrl).hostname, NPM_REGISTRY] }
}

export function runnerInput(
  request: FixRequest,
  options: Pick<SandboxFixerOptions, 'models' | 'limits'> & { proxyBaseUrl: string }
): RunnerInput {
  const { advisory, triage, instructions, untrustedContext, resume } = request
  return {
    workdir: sandboxLayout.work,
    configDir: sandboxLayout.claude,
    resultPath: files.result,
    scratchDir: sandboxLayout.io,
    tokenPath: files.token,
    session: resume ? { id: resume.session.id, resume: true } : { id: randomUUID(), resume: false },
    priorDiff: resume?.diff ?? null,
    proxyBaseUrl: options.proxyBaseUrl,
    models: options.models,
    limits: {
      maxTurns: options.limits.maxTurns,
      maxBudgetUsd: options.limits.maxBudgetUsd,
      testTimeoutMs: options.limits.testTimeoutMs
    },
    task: {
      advisory,
      triage: {
        reason: triage.reason,
        suspectedFiles: triage.suspectedFiles,
        fixStrategy: triage.fixStrategy
      },
      instructions,
      untrustedContext
    }
  }
}

function testResult(run: TestRun | null, fallback: string): TestResult {
  if (!run) return { passed: false, output: fallback }
  return { passed: run.passed, output: `$ ${run.command}\n(exit ${run.exitCode})\n${run.output}` }
}

const nothingSpent: ModelSpend = {
  usd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
}

function spent(totals: ModelSpend, before: ModelSpend): ModelSpend {
  const delta = (key: keyof ModelSpend) => Math.max(0, totals[key] - before[key])
  return {
    usd: delta('usd'),
    inputTokens: delta('inputTokens'),
    outputTokens: delta('outputTokens'),
    cacheReadTokens: delta('cacheReadTokens'),
    cacheWriteTokens: delta('cacheWriteTokens')
  }
}

export function fixResult(
  result: RunnerResult,
  transcript: string,
  sandboxSeconds: number,
  before: ModelSpend = nothingSpent
): FixResult {
  const totals: ModelSpend = {
    usd: result.usage.costUsd,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadInputTokens,
    cacheWriteTokens: result.usage.cacheCreationInputTokens
  }
  const session = { id: result.sessionId, transcript, totals }
  const problem = result.error ?? 'the fix session returned no report'
  const upstreamTests = result.report?.upstreamTestCommand
    ? testResult(result.upstreamTests, problem)
    : { passed: true, output: 'The package has no upstream test suite.' }
  const concerns = result.report?.concerns ?? []
  const summary = result.report
    ? [result.report.summary, ...concerns.map((concern) => `Concern: ${concern}`)].join('\n\n')
    : `The fix session did not finish: ${problem}`
  return {
    diff: result.diff,
    regressionBefore: testResult(result.regression?.before ?? null, problem),
    regressionAfter: testResult(result.regression?.after ?? null, problem),
    upstreamTests: result.report ? upstreamTests : { passed: false, output: problem },
    summary,
    cost: { ...spent(totals, before), sandboxSeconds },
    session
  }
}

async function collect(
  sandbox: Sandbox,
  request: FixRequest,
  runnerExit: string,
  sandboxSeconds: () => number
): Promise<FixResult> {
  const raw = await sandbox.readFileToBuffer({ path: files.result })
  if (!raw) throw new Error(`the fixer runner wrote no result (${runnerExit})`)
  const result = runnerResultSchema.parse(JSON.parse(raw.toString('utf8')))
  await check(sandbox, 'packing the session transcript', 'tar', [
    '-czf',
    files.transcript,
    '-C',
    sandboxLayout.transcripts,
    '.'
  ])
  const transcript = await sandbox.readFileToBuffer({ path: files.transcript })
  if (!transcript) throw new Error('the session transcript is missing')
  return fixResult(
    result,
    transcript.toString('base64'),
    sandboxSeconds(),
    request.resume?.session.totals
  )
}

export function createSandboxFixer(options: SandboxFixerOptions): Fixer {
  const { credentials, proxyBaseUrl, sourceArchive, limits, onLine } = options
  const now = options.now ?? (() => new Date())

  async function provision(sandbox: Sandbox) {
    await check(sandbox, 'creating directories', 'mkdir', ['-p', ...Object.values(sandboxLayout)])
    const runner = await runnerPackage()
    await sandbox.writeFiles(
      runner.map((file) => ({
        path: `${sandboxLayout.runner}/${file.path}`,
        content: file.content
      }))
    )
    await check(sandbox, 'preparing the Bash sandbox', 'sudo', ['bash', '-c', bashSandboxSetup])
    await check(
      sandbox,
      'installing the fixer runner',
      'npm',
      [
        'install',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        `--before=${new Date(now().getTime() - DAY_MS).toISOString()}`
      ],
      sandboxLayout.runner
    )
  }

  async function stage(sandbox: Sandbox, request: FixRequest, input: RunnerInput, token: string) {
    await sandbox.writeFiles([
      { path: files.source, content: await sourceArchive(request.source) },
      { path: files.input, content: JSON.stringify(input) },
      { path: files.token, content: token, mode: 0o600 },
      ...(request.resume
        ? [
            {
              path: files.transcript,
              content: Buffer.from(request.resume.session.transcript, 'base64')
            }
          ]
        : [])
    ])
    await check(sandbox, 'unpacking the package source', 'tar', [
      '-xzf',
      files.source,
      '-C',
      sandboxLayout.work,
      '--strip-components=1',
      '--no-same-owner'
    ])
    if (request.resume) {
      await check(sandbox, 'restoring the session transcript', 'tar', [
        '-xzf',
        files.transcript,
        '-C',
        sandboxLayout.transcripts
      ])
    }
  }

  async function runRunner(sandbox: Sandbox): Promise<string> {
    const command = await sandbox.runCommand({
      ...runnerCommand,
      cwd: sandboxLayout.runner,
      detached: true,
      timeoutMs: limits.sandboxTimeoutMs - 2 * 60_000
    })
    let stderr = ''
    const lines = lineSplitter((text) => {
      const line = parseRunnerLine(text)
      if (line) onLine?.(line)
    })
    for await (const log of command.logs()) {
      if (log.stream === 'stdout') lines.push(log.data)
      else stderr = (stderr + log.data).slice(-4000)
    }
    lines.end()
    const done = await command.wait()
    return `exit ${done.exitCode}${stderr ? `:\n${stderr}` : ''}`
  }

  return {
    async fix(request) {
      let sandbox: Sandbox | undefined
      try {
        const input = runnerInput(request, { ...options, proxyBaseUrl })
        const created = now().getTime()
        sandbox = await openSandbox({
          credentials,
          timeoutMs: limits.sandboxTimeoutMs,
          vcpus: options.vcpus,
          networkPolicy: 'allow-all',
          purpose: 'fixer'
        })
        await provision(sandbox)
        await sandbox.update({ networkPolicy: egressPolicy(proxyBaseUrl) })
        await stage(sandbox, request, input, request.modelToken)
        const runnerExit = await runRunner(sandbox)
        return await collect(sandbox, request, runnerExit, () =>
          Math.round((now().getTime() - created) / 1000)
        )
      } finally {
        await sandbox?.stop().catch(() => undefined)
      }
    }
  }
}
