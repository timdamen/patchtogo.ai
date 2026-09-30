import { spawn } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LeadReport, RunnerResult, TestRun, UpstreamSuite } from './protocol.ts'
import { isInside } from './workdir-guard.ts'

const OUTPUT_LIMIT = 16_000

type Verdict = NonNullable<RunnerResult['regression']>['verdict']

function regressionVerdict(before: TestRun, after: TestRun): Verdict {
  if (before.passed) return 'not-red-before'
  if (!after.passed) return 'not-green-after'
  return 'red-to-green'
}

export function clip(output: string, limit = OUTPUT_LIMIT): string {
  if (output.length <= limit) return output
  return `[${output.length - limit} characters cut]\n${output.slice(-limit)}`
}

export function testFilesInside(workdir: string, files: string[]): string[] {
  const outside = files.filter((file) => !isInside(path.resolve(workdir, file), workdir))
  if (outside.length > 0) throw new Error(`regression test files outside the package: ${outside}`)
  return files.map((file) => path.relative(workdir, path.resolve(workdir, file)))
}

export function testEnv(base: { PATH?: string; HOME?: string }): Record<string, string> {
  return {
    PATH: base.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: base.HOME ?? '/tmp',
    LANG: 'C.UTF-8',
    CI: '1'
  }
}

interface Exec {
  exitCode: number | null
  output: string
}

function exec(
  cmd: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number }
): Promise<Exec> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL'
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ exitCode: code, output: Buffer.concat(chunks).toString('utf8') })
    })
  })
}

export class Workspace {
  readonly #workdir: string
  readonly #env: Record<string, string>
  readonly #timeoutMs: number

  constructor(workdir: string, env: Record<string, string>, timeoutMs: number) {
    this.#workdir = workdir
    this.#env = env
    this.#timeoutMs = timeoutMs
  }

  async git(...args: string[]): Promise<string> {
    const result = await exec(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=patchtogo fixer',
        '-c',
        'user.email=fixer@patchtogo.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args
      ],
      { cwd: this.#workdir, env: { ...this.#env, GIT_CONFIG_NOSYSTEM: '1' }, timeoutMs: 120_000 }
    )
    if (result.exitCode !== 0)
      throw new Error(`git ${args[0]} failed: ${clip(result.output, 2000)}`)
    return result.output
  }

  async snapshot(message: string): Promise<string> {
    await this.git('add', '--all')
    await this.git('commit', '--quiet', '--allow-empty', '--no-verify', '-m', message)
    return (await this.git('rev-parse', 'HEAD')).trim()
  }

  async init(): Promise<string> {
    await this.git('init', '--quiet')
    await appendFile(path.join(this.#workdir, '.git', 'info', 'exclude'), '\nnode_modules/\n')
    return this.snapshot('original package source')
  }

  async apply(diff: string, scratchDir: string): Promise<void> {
    const patchFile = path.join(scratchDir, 'prior.diff')
    await writeFile(patchFile, diff)
    await this.git('apply', '--binary', '--whitespace=nowarn', patchFile)
  }

  diff(base: string, patched: string): Promise<string> {
    return this.git('diff', '--binary', '--no-color', '--no-ext-diff', base, patched)
  }

  async run(command: string): Promise<TestRun> {
    const result = await exec('bash', ['-c', command], {
      cwd: this.#workdir,
      env: this.#env,
      timeoutMs: this.#timeoutMs
    })
    return {
      command,
      exitCode: result.exitCode,
      passed: result.exitCode === 0,
      output: clip(result.output)
    }
  }

  async readFile(file: string): Promise<string | undefined> {
    try {
      return await readFile(path.join(this.#workdir, file), 'utf8')
    } catch {
      return undefined
    }
  }

  async checkout(commit: string, files: string[] = []): Promise<void> {
    if (files.length === 0) {
      await this.git('checkout', '--quiet', '--force', '--detach', commit)
      return
    }
    await this.git('checkout', '--quiet', commit, '--', ...files)
  }
}

export async function rerunRegression(
  workspace: Workspace,
  commits: { base: string; patched: string },
  test: LeadReport['regressionTest'],
  testFiles: string[]
): Promise<NonNullable<RunnerResult['regression']>> {
  await workspace.checkout(commits.patched)
  const after = await workspace.run(test.command)
  await workspace.checkout(commits.base)
  await workspace.checkout(commits.patched, testFiles)
  const before = await workspace.run(test.command)
  await workspace.checkout(commits.patched)
  return { before, after, verdict: regressionVerdict(before, after) }
}

const INSTALL = 'npm install --no-save --no-package-lock --no-audit --no-fund'

const TEST = 'npm test'

const npmPlaceholder = /no test specified/i

type Manifest = { scripts: string } | { reason: string }

function manifestOf(text: string | undefined): Manifest {
  if (text === undefined) return { reason: 'The package has no package.json.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { reason: 'The package.json of the package is not valid JSON.' }
  }
  const scripts = (parsed as { scripts?: unknown } | null)?.scripts
  const test = (scripts as { test?: unknown } | null | undefined)?.test
  if (typeof test !== 'string' || !test.trim()) {
    return { reason: 'The package.json of the package has no test script.' }
  }
  if (npmPlaceholder.test(test)) {
    return { reason: `The test script in package.json is npm's placeholder, which only fails.` }
  }
  return { scripts: JSON.stringify(scripts) }
}

function changedScripts(): TestRun {
  return {
    command: TEST,
    exitCode: null,
    passed: false,
    output:
      'The patch changes the scripts in package.json, so the upstream test suite of the base branch cannot be run on the patched code.'
  }
}

export async function rerunUpstreamSuite(
  workspace: Workspace,
  commits: { base: string; patched: string }
): Promise<UpstreamSuite> {
  await workspace.checkout(commits.base)
  const base = manifestOf(await workspace.readFile('package.json'))
  if ('reason' in base) {
    await workspace.checkout(commits.patched)
    return { suite: 'none', reason: base.reason }
  }
  await workspace.git('clean', '-ffdqX')
  const install = await workspace.run(INSTALL)
  const before = install.passed ? await workspace.run(TEST) : install
  await workspace.checkout(commits.patched)
  const patched = manifestOf(await workspace.readFile('package.json'))
  const after =
    !('scripts' in patched) || patched.scripts !== base.scripts
      ? changedScripts()
      : install.passed
        ? await workspace.run(TEST)
        : install
  return { suite: 'ran', command: TEST, before, after }
}
