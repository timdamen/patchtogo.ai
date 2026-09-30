import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  Workspace,
  clip,
  rerunRegression,
  rerunUpstreamSuite,
  testEnv,
  testFilesInside
} from '../src/verify.ts'
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

  it("keeps the empty files Claude Code's sandbox leaves in the package out of the diff", async () => {
    await writeFile(path.join(workdir, 'yarn.lock'), '')
    const base = await workspace.init()
    await writeFile(path.join(workdir, 'index.js'), fixed)
    await mkdir(path.join(workdir, 'test', 'fixtures'), { recursive: true })
    await writeFile(path.join(workdir, 'test', 'fixtures', 'empty.json'), '')
    await mkdir(path.join(workdir, '.claude'))
    for (const placeholder of ['.npmrc', '.env.local', 'pnpm-lock.yaml', '.claude/agents']) {
      await writeFile(path.join(workdir, placeholder), '')
    }

    const { commit } = await workspace.snapshotSession()
    const diff = await workspace.diff(base, commit)

    expect(diff.match(/^diff --git a\/\S+/gm)).toEqual([
      'diff --git a/index.js',
      'diff --git a/test/fixtures/empty.json'
    ])
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

describe('upstream test suite', () => {
  const add = 'module.exports = (a, b) => a + b\n'
  const suite = 'const add = require("./index.js")\nif (add(1, 2) !== 3) process.exit(1)\n'

  async function workspaceWith(scripts: Record<string, string> | undefined) {
    const workdir = await mkdtemp(path.join(tmpdir(), 'ptg-suite-'))
    const manifest = { name: 'add', version: '1.0.0', ...(scripts ? { scripts } : {}) }
    await writeFile(path.join(workdir, 'package.json'), JSON.stringify(manifest))
    await writeFile(path.join(workdir, 'index.js'), add)
    await writeFile(path.join(workdir, 'suite.js'), suite)
    const workspace = new Workspace(workdir, testEnv(process.env), 60_000)
    const base = await workspace.init()
    async function patch(files: Record<string, string>) {
      for (const [file, content] of Object.entries(files)) {
        await writeFile(path.join(workdir, file), content)
      }
      return { base, patched: await workspace.snapshot('patched') }
    }
    return { workdir, workspace, patch }
  }

  it.each([
    ['has no test script', undefined, 'has no test script'],
    [
      'keeps the test script npm init writes',
      { test: 'echo "Error: no test specified" && exit 1' },
      "npm's placeholder"
    ]
  ])('records no suite, never a pass, when the package %s', async (_case, scripts, reason) => {
    const { workdir, workspace, patch } = await workspaceWith(scripts)
    const commits = await patch({ 'index.js': `${add}// patched\n` })

    const result = await rerunUpstreamSuite(workspace, commits)

    expect(result).toEqual({ suite: 'none', reason: expect.stringContaining(reason) })
    expect(await readFile(path.join(workdir, 'index.js'), 'utf8')).toContain('// patched')
  })

  it("runs the base branch's npm test on both trees after a clean install", async () => {
    const { workdir, workspace, patch } = await workspaceWith({ test: 'node suite.js' })
    await mkdir(path.join(workdir, 'node_modules'))
    await writeFile(path.join(workdir, 'node_modules', 'planted.js'), '')
    const commits = await patch({ 'index.js': 'module.exports = (a, b) => a - b\n' })

    const result = await rerunUpstreamSuite(workspace, commits)

    expect(result).toMatchObject({
      suite: 'ran',
      command: 'npm test',
      before: { passed: true },
      after: { passed: false, exitCode: 1 }
    })
    expect(await readFile(path.join(workdir, 'index.js'), 'utf8')).toContain('a - b')
    await expect(readFile(path.join(workdir, 'node_modules', 'planted.js'))).rejects.toThrow()
  })

  it('fails the patched run when the patch changes the package scripts', async () => {
    const { workspace, patch } = await workspaceWith({ test: 'node suite.js' })
    const commits = await patch({
      'index.js': 'module.exports = () => 0\n',
      'package.json': JSON.stringify({ name: 'add', version: '1.0.0', scripts: { test: 'true' } })
    })

    const result = await rerunUpstreamSuite(workspace, commits)

    expect(result).toMatchObject({
      suite: 'ran',
      before: { passed: true },
      after: { passed: false, output: expect.stringContaining('changes the scripts') }
    })
  })
})
