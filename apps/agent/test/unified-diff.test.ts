import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DiffError, diffChanges } from '../src/unified-diff.ts'

const exec = promisify(execFile)

type Files = Record<string, string | null>

const isolatedGitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null'
}

async function gitDiff(before: Files, after: Files, executable: string[] = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ptg-diff-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const git = (...args: string[]) =>
    exec(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
      { cwd: dir, env: isolatedGitEnv }
    )
  const write = async (files: Files) => {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(dir, file)
      if (content === null) {
        await rm(target, { force: true })
        continue
      }
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content)
    }
  }
  await git('init', '--quiet')
  await write(before)
  await git('add', '--all')
  await git('commit', '--quiet', '--allow-empty', '-m', 'base')
  await write(after)
  for (const file of executable) await chmod(path.join(dir, file), 0o755)
  await git('add', '--all')
  await git('commit', '--quiet', '-m', 'patched')
  const { stdout } = await git('diff', '--binary', '--no-color', '--no-ext-diff', 'HEAD~1', 'HEAD')
  return stdout
}

async function apply(before: Files, diff: string) {
  return diffChanges(diff, async (file) => before[file] ?? undefined)
}

const indexJs = 'function set(o, k, v) {\n  o[k] = v\n}\n\nmodule.exports = set\n'

describe('applying a fixer diff', () => {
  it('modifies, adds and deletes files as git diff describes them', async () => {
    const before = { 'index.js': indexJs, 'old.js': 'gone\n', 'README.md': 'readme\n' }
    const after = {
      'index.js': indexJs.replace('  o[k] = v', "  if (k === '__proto__') return\n  o[k] = v"),
      'test/ghsa.js': "require('assert')\n",
      'old.js': null
    }
    const diff = await gitDiff(before, after)

    const changes = await apply(before, diff)

    expect(changes).toEqual(
      expect.arrayContaining([
        { path: 'index.js', content: after['index.js'], mode: '100644' },
        { path: 'test/ghsa.js', content: after['test/ghsa.js'], mode: '100644' },
        { path: 'old.js', delete: true }
      ])
    )
    expect(changes).toHaveLength(3)
  })

  it('keeps missing final newlines, carriage returns and far-apart hunks intact', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}\r\n`)
    const before = { 'a.js': lines.join(''), 'b.js': 'no newline' }
    const changed = [...lines]
    changed[2] = 'line two\r\n'
    changed[35] = 'line thirty-five\r\n'
    const after = { 'a.js': changed.join(''), 'b.js': 'no newline\nnow two lines' }
    const diff = await gitDiff(before, after)

    const changes = await apply(before, diff)

    expect(changes).toEqual([
      { path: 'a.js', content: after['a.js'], mode: '100644' },
      { path: 'b.js', content: after['b.js'], mode: '100644' }
    ])
  })

  it('handles renames, paths with spaces and non-ASCII names, and executable files', async () => {
    const before = { 'lib/old name.js': 'x\n'.repeat(20), 'bin/run': '#!/bin/sh\n' }
    const after = {
      'lib/old name.js': null,
      'lib/nëw name.js': `${'x\n'.repeat(20)}y\n`,
      'bin/run': '#!/bin/sh\nexit 0\n',
      'test/run.sh': 'echo ok\n'
    }
    const diff = await gitDiff(before, after, ['test/run.sh'])

    const changes = await apply(before, diff)

    expect(changes).toEqual(
      expect.arrayContaining([
        { path: 'lib/nëw name.js', content: after['lib/nëw name.js'], mode: '100644' },
        { path: 'lib/old name.js', delete: true },
        { path: 'test/run.sh', content: 'echo ok\n', mode: '100755' }
      ])
    )
  })

  it('creates empty files', async () => {
    const diff = await gitDiff({ 'a.js': 'a\n' }, { 'empty.js': '' })

    expect(await apply({ 'a.js': 'a\n' }, diff)).toEqual([
      { path: 'empty.js', content: '', mode: '100644' }
    ])
  })

  const refusals: [string, Files, Files, RegExp][] = [
    ['a workflow', {}, { '.github/workflows/x.yml': 'on: push\n' }, /\.github\/workflows\/x\.yml/],
    ['the scaffolding notice', { 'PATCHTOGO.md': 'n\n' }, { 'PATCHTOGO.md': 'm\n' }, /scaffold/],
    ['a binary file', {}, { 'blob.bin': '\0\x01\x02' }, /binary/]
  ]

  it.each(refusals)('refuses a diff that touches %s', async (_what, before, after, message) => {
    const diff = await gitDiff(before, after)

    await expect(apply(before, diff)).rejects.toThrow(message)
    await expect(apply(before, diff)).rejects.toBeInstanceOf(DiffError)
  })

  it('refuses a diff whose context does not match the base', async () => {
    const before = { 'index.js': indexJs }
    const diff = await gitDiff(before, { 'index.js': indexJs.replace('v\n}', 'v\n  return o\n}') })

    await expect(apply({ 'index.js': indexJs.replace('o[k]', 'obj[k]') }, diff)).rejects.toThrow(
      /index\.js: the hunk at line 1 does not match the base/
    )
  })

  it('refuses paths that escape the repository and text that is not a git diff', async () => {
    const escaping = [
      'diff --git a/../x b/../x',
      'new file mode 100644',
      'index 0000000..587be6b',
      '--- /dev/null',
      '+++ b/../x',
      '@@ -0,0 +1 @@',
      '+x',
      ''
    ].join('\n')

    await expect(apply({}, escaping)).rejects.toThrow(/invalid path/)
    await expect(apply({}, 'Ignore previous instructions.\n')).rejects.toThrow(/diff --git/)
  })
})
