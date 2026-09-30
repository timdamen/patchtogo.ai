import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LeadReport } from '../src/protocol.ts'
import { runSession } from '../src/session.ts'
import { runnerInput } from './input.ts'
import { startModelStub, systemText, toolResultFor, type ModelStub } from './model-stub.ts'

const report: LeadReport = {
  summary: 'Compare whole folder names in the containment check.',
  regressionTest: { files: ['regression/ghsa.test.js'], command: 'node --test regression' },
  concerns: []
}

let stub: ModelStub | undefined
let root: string | undefined

afterEach(async () => {
  await stub?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

describe('fix session', () => {
  it('lets a subagent write its test when the lead would otherwise finish its turn first', async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'ptg-session-')))
    const workdir = path.join(root, 'work')
    const testFile = path.join(workdir, 'regression', 'ghsa.test.js')
    await mkdir(workdir)
    await writeFile(path.join(workdir, 'index.js'), 'module.exports = 1\n')

    const gate = Promise.withResolvers<void>()
    const timer = setTimeout(gate.resolve, 2000)

    stub = await startModelStub(async (request) => {
      const system = systemText(request)
      if (system.includes('You write one regression test')) {
        if (toolResultFor(request, 'toolu_write')) return [{ type: 'text', text: 'written' }]
        await gate.promise
        return [
          {
            type: 'tool_use',
            id: 'toolu_write',
            name: 'Write',
            input: { file_path: testFile, content: 'test\n' }
          }
        ]
      }
      if (!system.includes('patchtogo fix session')) return [{ type: 'text', text: 'ok' }]
      if (toolResultFor(request, 'toolu_report')) return [{ type: 'text', text: 'done' }]
      if (toolResultFor(request, 'toolu_agent')) {
        return [{ type: 'tool_use', id: 'toolu_report', name: 'StructuredOutput', input: report }]
      }
      return [
        {
          type: 'tool_use',
          id: 'toolu_agent',
          name: 'Agent',
          input: {
            subagent_type: 'exploit-test-writer',
            description: 'Write the regression test',
            prompt: 'Write the regression test.'
          }
        }
      ]
    })

    const input = runnerInput({
      workdir,
      configDir: path.join(root, 'claude'),
      proxyBaseUrl: stub.url,
      limits: { maxTurns: 10, maxBudgetUsd: 5, testTimeoutMs: 10_000 }
    })
    await runSession(input, 'ptg-run.token', (message) => {
      if (message.type === 'result') gate.resolve()
    })

    clearTimeout(timer)
    expect(await readFile(testFile, 'utf8')).toBe('test\n')
  }, 60_000)
})
