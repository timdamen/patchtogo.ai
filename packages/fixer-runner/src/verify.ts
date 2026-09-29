import { spawn } from 'node:child_process'
import { appendFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LeadReport, RunnerResult, TestRun } from './protocol.ts'
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
