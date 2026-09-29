import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Workspace, clip, rerunRegression, testEnv, testFilesInside } from '../src/verify.ts'
import { inheritedEnv } from './input.ts'

describe('test output', () => {
  it('keeps the tail of long output', () => {
    const clipped = clip(`${'a'.repeat(50)}END`, 10)
    expect(clipped).toBe('[43 characters cut]\naaaaaaaEND')
  })
})

describe('regression test files', () => {
  it('normalises paths inside the package and rejects paths outside it', () => {
    expect(testFilesInside('/w', ['test/a.js', '/w/test/b.js'])).toEqual(['test/a.js', 'test/b.js'])
    expect(() => testFilesInside('/w', ['../runner/src/main.ts'])).toThrow(/outside the package/)
  })

  it('gives test commands only PATH, HOME, LANG and CI', () => {
    expect(testEnv(inheritedEnv)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/ubuntu',
      LANG: 'C.UTF-8',
      CI: '1'
    })
  })
})

describe('deterministic re-run', () => {
  let workdir: string
  let workspace: Workspace

  const vulnerable = 'module.exports = (o, k, v) => { Object.assign((o[k] ??= {}), v) }\n'
  const fixed =
    "module.exports = (o, k, v) => { if (k !== '__proto__') Object.assign((o[k] ??= {}), v) }\n"
  const regression = [
    "const set = require('../index.js')",
    "set({}, '__proto__', { polluted: true })",
    'if ({}.polluted) process.exit(1)'
  ].join('\n')

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), 'ptg-verify-'))
    await writeFile(path.join(workdir, 'index.js'), vulnerable)
    workspace = new Workspace(workdir, testEnv(process.env), 30_000)
  })

  async function session(source: string) {
    const base = await workspace.init()
    await mkdir(path.join(workdir, 'test'))
    await writeFile(path.join(workdir, 'test', 'regression.js'), regression)
    await writeFile(path.join(workdir, 'index.js'), source)
    const patched = await workspace.snapshot('patched')
    return { base, patched }
  }

  const test = { files: ['test/regression.js'], command: 'node test/regression.js' }

  it('runs the regression test on the original and the patched tree', async () => {
    const commits = await session(fixed)
    const result = await rerunRegression(workspace, commits, test, test.files)

    expect(result.verdict).toBe('red-to-green')
    expect(result.before.exitCode).toBe(1)
    expect(result.after.exitCode).toBe(0)
    expect(await readFile(path.join(workdir, 'index.js'), 'utf8')).toBe(fixed)
  })

  it('does not trust a patch that leaves the package vulnerable', async () => {
    const commits = await session(vulnerable)
    const result = await rerunRegression(workspace, commits, test, test.files)
    expect(result.verdict).toBe('not-green-after')
  })

  it('does not trust a regression test that already passes on the original source', async () => {
    const commits = await session(fixed)
    const result = await rerunRegression(
      workspace,
      commits,
      { ...test, command: 'node index.js' },
      test.files
    )
    expect(result.before.passed).toBe(true)
    expect(result.after.passed).toBe(true)
    expect(result.verdict).toBe('not-red-before')
  })

  it('produces a diff of the fix and the test against the original source', async () => {
    const { base, patched } = await session(fixed)
    const diff = await workspace.diff(base, patched)
    expect(diff).toContain('+++ b/index.js')
    expect(diff).toContain('+++ b/test/regression.js')
  })

  it('applies a prior diff so a resumed session starts from its last patch', async () => {
    const { base, patched } = await session(fixed)
    const diff = await workspace.diff(base, patched)

    const next = await mkdtemp(path.join(tmpdir(), 'ptg-verify-'))
    await writeFile(path.join(next, 'index.js'), vulnerable)
    const resumed = new Workspace(next, testEnv(process.env), 30_000)
    const resumedBase = await resumed.init()
    await resumed.apply(diff, await mkdtemp(path.join(tmpdir(), 'ptg-scratch-')))
    const resumedPatched = await resumed.snapshot('patched')

    expect(await resumed.diff(resumedBase, resumedPatched)).toBe(diff)
  })
})
