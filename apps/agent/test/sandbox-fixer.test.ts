import { runnerInputSchema, type RunnerResult } from '@patchtogo/fixer-runner/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeLine, lineSplitter, parseRunnerLine } from '../src/fixer/runner-lines.ts'
import { runnerPackage } from '../src/fixer/runner-package.ts'
import { createSandboxFixer } from '../src/fixer/sandbox-fixer.ts'
import type { FixRequest } from '../src/pipeline/ports.ts'

const sandbox = vi.hoisted(() => {
  interface Write {
    path: string
    content: string
    mode: number | undefined
    policy: unknown
  }
  interface Run {
    cmd: string
    args: string[]
    detached: boolean
    policy: unknown
  }
  const state = {
    policy: undefined as unknown,
    files: new Map<string, Buffer>(),
    writes: [] as Write[],
    runs: [] as Run[],
    stopped: false,
    runner: { result: undefined as unknown, exitCode: 0, stderr: '', seconds: 0 }
  }

  function runner() {
    return {
      async *logs() {
        if (state.runner.stderr) yield { stream: 'stderr', data: state.runner.stderr }
      },
      async wait() {
        vi.setSystemTime(Date.now() + state.runner.seconds * 1000)
        const input = JSON.parse(state.files.get('/vercel/ptg/io/input.json')?.toString() ?? '{}')
        if (state.runner.result !== undefined) {
          state.files.set(input.resultPath, Buffer.from(JSON.stringify(state.runner.result)))
        }
        return { exitCode: state.runner.exitCode }
      }
    }
  }

  const instance = {
    async update(params: { networkPolicy: unknown }) {
      state.policy = params.networkPolicy
    },
    async writeFiles(files: { path: string; content: string | Uint8Array; mode?: number }[]) {
      for (const file of files) {
        const content = Buffer.from(file.content)
        state.files.set(file.path, content)
        state.writes.push({
          path: file.path,
          content: content.toString(),
          mode: file.mode,
          policy: state.policy
        })
      }
    },
    async runCommand(params: { cmd: string; args: string[]; detached?: boolean }) {
      const detached = params.detached === true
      state.runs.push({ cmd: params.cmd, args: params.args, detached, policy: state.policy })
      if (detached) return runner()
      const [flag, archive] = params.args
      if (params.cmd === 'tar' && flag === '-czf' && archive) {
        state.files.set(archive, Buffer.from('transcript tarball'))
      }
      return { exitCode: 0, output: async () => '', stdout: async () => '' }
    },
    async readFileToBuffer(file: { path: string }) {
      return state.files.get(file.path) ?? null
    },
    async stop() {
      state.stopped = true
      return {}
    }
  }

  return {
    state,
    reset() {
      state.policy = undefined
      state.files.clear()
      state.writes = []
      state.runs = []
      state.stopped = false
      state.runner = { result: undefined, exitCode: 0, stderr: '', seconds: 0 }
    },
    async create(params: { networkPolicy: unknown }) {
      state.policy = params.networkPolicy
      return instance
    }
  }
})

vi.mock('@vercel/sandbox', () => ({ Sandbox: { create: sandbox.create } }))

const runToken = 'ptg-run.eyJydW4iOiJ4In0.c2lnbmF0dXJl'

const request: FixRequest = {
  runId: 'GHSA-p6mc-m468-83gw:lodash.set',
  advisory: {
    ghsaId: 'GHSA-p6mc-m468-83gw',
    cveId: 'CVE-2020-8203',
    packageName: 'lodash.set',
    vulnerableRange: '>= 3.7.0, <= 4.3.2',
    patchedVersion: null,
    severity: 'high',
    summary: 'Prototype Pollution in lodash',
    description: 'Prototype pollution in zipObjectDeep.'
  },
  triage: {
    decision: 'patch',
    reason: 'small fix',
    suspectedFiles: ['index.js'],
    fixStrategy: 'refuse prototype keys'
  },
  source: { repository: 'patchtogo-ai/lodash.set', branch: 'ptg/base-4.3.2' },
  modelToken: runToken,
  instructions: [],
  untrustedContext: ['a comment']
}

const finished: RunnerResult = {
  sessionId: '6f1c1f0e-8a8e-4c55-9d7e-0c4a1c2b3d4e',
  report: {
    summary: 'Refuse __proto__ path segments.',
    regressionTest: { files: ['test/ghsa.js'], command: 'node test/ghsa.js' },
    upstreamTestCommand: 'npm test',
    concerns: ['constructor.prototype is guarded too']
  },
  error: null,
  diff: 'diff --git a/index.js b/index.js\n',
  regression: {
    before: { command: 'node test/ghsa.js', exitCode: 1, passed: false, output: 'polluted' },
    after: { command: 'node test/ghsa.js', exitCode: 0, passed: true, output: '' },
    verdict: 'red-to-green'
  },
  upstreamTests: { command: 'npm test', exitCode: 0, passed: true, output: 'ok' },
  usage: {
    costUsd: 2.5,
    inputTokens: 1200,
    outputTokens: 800,
    cacheReadInputTokens: 50_000,
    cacheCreationInputTokens: 9000,
    turns: 30
  }
}

const earlier = {
  usd: 1,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 20_000,
  cacheWriteTokens: 5000
}

const resumed: FixRequest = {
  ...request,
  resume: {
    session: { id: finished.sessionId, transcript: 'dGFy', totals: earlier },
    diff: finished.diff
  }
}

const io = {
  input: '/vercel/ptg/io/input.json',
  token: '/vercel/ptg/io/token',
  source: '/vercel/ptg/io/source.tgz',
  transcript: '/vercel/ptg/io/transcript.tgz'
}

function written(path: string) {
  const write = sandbox.state.writes.find((entry) => entry.path === path)
  if (!write) throw new Error(`${path} was never written`)
  return write
}

function runnerRun() {
  const run = sandbox.state.runs.find((entry) => entry.detached)
  if (!run) throw new Error('the runner never started')
  return run
}

describe('runner JSON lines', () => {
  it('reassembles lines split across log chunks', () => {
    const lines: string[] = []
    const splitter = lineSplitter((line) => lines.push(line))
    splitter.push('{"type":"sys')
    splitter.push('tem"}\n{"type":"result"}\n\n{"type":')
    splitter.push('"assistant"}')
    splitter.end()
    expect(lines).toEqual(['{"type":"system"}', '{"type":"result"}', '{"type":"assistant"}'])
  })

  it('ignores lines that are not typed JSON objects', () => {
    expect(parseRunnerLine('npm warn deprecated')).toBeUndefined()
    expect(parseRunnerLine('[1,2]')).toBeUndefined()
    expect(parseRunnerLine('{"no":"type"}')).toBeUndefined()
    expect(parseRunnerLine('{"type":"result","total_cost_usd":1}')).toEqual({
      type: 'result',
      total_cost_usd: 1
    })
  })

  it('describes subagent delegation and cost for progress output', () => {
    expect(
      describeLine({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Agent',
              input: { subagent_type: 'investigator', description: 'find the sink' }
            }
          ]
        }
      })
    ).toBe('delegating to investigator: find the sink')
    expect(
      describeLine({ type: 'result', subtype: 'success', num_turns: 30, total_cost_usd: 2.5 })
    ).toBe('session success after 30 turns, $2.50')
    expect(
      describeLine({
        type: 'system',
        subtype: 'init',
        session_id: 's1',
        model: 'claude-opus-5-5',
        tools: ['Read', 'Agent'],
        mcp_servers: []
      })
    ).toBe('session s1 on claude-opus-5-5, tools [Read, Agent], MCP servers []')
    expect(describeLine({ type: 'user' })).toBeUndefined()
  })
})

describe('sandbox fixer', () => {
  const fixer = createSandboxFixer({
    proxyBaseUrl: 'https://agent.patchtogo.test/model-proxy',
    sourceArchive: async () => new TextEncoder().encode('package source'),
    models: { lead: 'claude-opus-5-5', subagents: {} },
    limits: { maxTurns: 80, maxBudgetUsd: 10, testTimeoutMs: 300_000, sandboxTimeoutMs: 2_400_000 }
  })
  const fix = (fixRequest: FixRequest = request) => fixer.fix(fixRequest)

  beforeEach(() => {
    sandbox.reset()
    sandbox.state.runner.result = finished
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('locks egress to the model proxy and npm before it stages the source, input and token', async () => {
    await fix()

    const locked = { allow: ['agent.patchtogo.test', 'registry.npmjs.org'] }
    const staged = sandbox.state.writes.filter((write) => write.path.startsWith('/vercel/ptg/io/'))
    expect(staged.map((write) => write.path).toSorted()).toEqual(
      [io.input, io.source, io.token].toSorted()
    )
    for (const write of staged) expect(write.policy).toEqual(locked)
    expect(runnerRun().policy).toEqual(locked)
  })

  it('hands the runner the run token only as a private file named in its input', async () => {
    await fix()

    const holders = sandbox.state.writes.filter((write) => write.content.includes(runToken))
    expect(holders.map(({ path, content, mode }) => ({ path, content, mode }))).toEqual([
      { path: io.token, content: runToken, mode: 0o600 }
    ])
    expect(sandbox.state.runs.flatMap((run) => run.args).join(' ')).not.toContain(runToken)
    const input = JSON.parse(written(io.input).content)
    expect(runnerInputSchema.parse(input)).toEqual(input)
    expect(input.tokenPath).toBe(io.token)
    expect(input.session.resume).toBe(false)
    expect(input.priorDiff).toBeNull()
  })

  it('starts the shipped runner without capabilities or a way to regain them', async () => {
    await fix()

    const { cmd, args } = runnerRun()
    expect({ cmd, args }).toEqual({
      cmd: 'setpriv',
      args: [
        '--no-new-privs',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--bounding-set=-all',
        'node',
        '/vercel/ptg/runner/src/main.ts',
        io.input
      ]
    })
    expect(written('/vercel/ptg/runner/src/main.ts').content).toContain('rerunRegression')
  })

  it('stops the sandbox when the runner writes no result', async () => {
    sandbox.state.runner = {
      result: undefined,
      exitCode: 1,
      stderr: 'Error: out of memory',
      seconds: 0
    }

    await expect(fix()).rejects.toThrow(
      'the fixer runner wrote no result (exit 1:\nError: out of memory)'
    )
    expect(sandbox.state.stopped).toBe(true)
  })

  it('resumes the stored session on top of the previous diff', async () => {
    await fix(resumed)

    const input = JSON.parse(written(io.input).content)
    expect(input.session).toEqual({ id: finished.sessionId, resume: true })
    expect(input.priorDiff).toBe(finished.diff)
    expect(written(io.transcript).content).toBe('tar')
  })

  it("maps the runner's re-run, usage and concerns into the fix result", async () => {
    sandbox.state.runner.seconds = 95
    const result = await fix()

    expect(result.regressionBefore.passed).toBe(false)
    expect(result.regressionBefore.output).toContain('(exit 1)')
    expect(result.regressionAfter.passed).toBe(true)
    expect(result.upstreamTests.passed).toBe(true)
    expect(result.summary).toContain('Concern: constructor.prototype is guarded too')
    expect(result.cost).toEqual({
      usd: 2.5,
      inputTokens: 1200,
      outputTokens: 800,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 9000,
      sandboxSeconds: 95
    })
    expect(result.session).toMatchObject({
      id: finished.sessionId,
      transcript: Buffer.from('transcript tarball').toString('base64')
    })
  })

  it('charges a resumed session only for what it spent since the stored totals', async () => {
    sandbox.state.runner.seconds = 40
    const result = await fix(resumed)

    expect(result.cost).toEqual({
      usd: 1.5,
      inputTokens: 200,
      outputTokens: 300,
      cacheReadTokens: 30_000,
      cacheWriteTokens: 4000,
      sandboxSeconds: 40
    })
    expect(result.session.totals.usd).toBe(2.5)
  })

  it('turns a session without a report into a result that is not red-to-green', async () => {
    sandbox.state.runner.result = {
      ...finished,
      report: null,
      regression: null,
      upstreamTests: null,
      error: 'budget spent'
    }
    const result = await fix()

    expect(result.regressionBefore.passed).toBe(false)
    expect(result.regressionAfter.passed).toBe(false)
    expect(result.summary).toBe('The fix session did not finish: budget spent')
  })

  it('ships the runner sources with only its runtime dependencies', async () => {
    const files = await runnerPackage()
    const manifest = JSON.parse(files.find((file) => file.path === 'package.json')?.content ?? '{}')
    expect(Object.keys(manifest.dependencies)).toEqual(['@anthropic-ai/claude-agent-sdk', 'zod'])
    expect(manifest.devDependencies).toBeUndefined()
    expect(manifest.dependencies['@anthropic-ai/claude-agent-sdk']).toMatch(/^\d+\.\d+\.\d+$/)
    expect(files.map((file) => file.path)).toContain('src/main.ts')
    expect(files.every((file) => !file.path.startsWith('test/'))).toBe(true)
  })
})
