import type { RunnerResult } from '@patchtogo/fixer-runner/protocol'
import { runnerInputSchema } from '@patchtogo/fixer-runner/protocol'
import { describe, expect, it } from 'vitest'
import { describeLine, lineSplitter, parseRunnerLine } from '../src/fixer/runner-lines.ts'
import { runnerPackage } from '../src/fixer/runner-package.ts'
import { egressPolicy, fixResult, runnerCommand, runnerInput } from '../src/fixer/sandbox-fixer.ts'
import type { FixRequest } from '../src/pipeline/ports.ts'

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
  modelToken: 'ptg-run.eyJydW4iOiJ4In0.c2lnbmF0dXJl',
  instructions: [],
  untrustedContext: ['a comment']
}

const settings = {
  proxyBaseUrl: 'https://agent.patchtogo.ai/model-proxy',
  models: { lead: 'claude-opus-5-5', subagents: {} },
  limits: { maxTurns: 80, maxBudgetUsd: 10, testTimeoutMs: 300_000, sandboxTimeoutMs: 2_400_000 }
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
  it('limits egress to the model proxy and the npm registry', () => {
    expect(egressPolicy('https://agent.patchtogo.ai/model-proxy')).toEqual({
      allow: ['agent.patchtogo.ai', 'registry.npmjs.org']
    })
  })

  it('starts the runner without capabilities or a way to regain them', () => {
    expect(runnerCommand.cmd).toBe('setpriv')
    expect(runnerCommand.args).toEqual(
      expect.arrayContaining([
        '--no-new-privs',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--bounding-set=-all'
      ])
    )
  })

  it('passes the runner no credentials besides the path of the run token file', () => {
    const input = runnerInput(request, settings)
    expect(runnerInputSchema.parse(input)).toEqual(input)
    const serialised = JSON.stringify(input)
    expect(serialised).not.toMatch(/sk-ant|ghp_|npm_|postgres:\/\/|ptg-run\./)
    expect(input.tokenPath).toMatch(/^\/vercel\/ptg\//)
    expect(input.session.resume).toBe(false)
    expect(input.priorDiff).toBeNull()
  })

  it('resumes the stored session on top of the previous diff', () => {
    const input = runnerInput(
      {
        ...request,
        resume: {
          session: { id: finished.sessionId, transcript: 'dGFy', totals: earlier },
          diff: finished.diff
        }
      },
      settings
    )
    expect(input.session).toEqual({ id: finished.sessionId, resume: true })
    expect(input.priorDiff).toBe(finished.diff)
  })

  it('reports the deterministic re-run, not the model, as the regression result', () => {
    const result = fixResult(finished, 'dGFy', 95)
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
    expect(result.session).toMatchObject({ id: finished.sessionId, transcript: 'dGFy' })
  })

  it('charges a resumed session only for what it spent since the stored totals', () => {
    const result = fixResult(finished, 'dGFy', 40, earlier)
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

  it('turns a session without a report into a result that is not red-to-green', () => {
    const result = fixResult(
      { ...finished, report: null, regression: null, upstreamTests: null, error: 'budget spent' },
      'dGFy',
      95
    )
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
