import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { previewWorkflow } from '../src/preview-workflow.ts'

const run = promisify(execFile)

interface Workflow {
  jobs: { build: { env: Record<string, string>; steps: { run?: string }[] } }
}

const commit = `0123456${'a'.repeat(33)}`
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('preview workflow', () => {
  it('packs the patch commit as an unreviewed preview under its own prerelease version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ptg-preview-'))
    roots.push(root)
    const checkout = join(root, 'checkout')
    await mkdir(checkout)
    await writeFile(
      join(checkout, 'package.json'),
      JSON.stringify({
        name: '@patchtogo.ai/escape-html',
        version: '1.0.3-ptg.1',
        main: 'index.js'
      })
    )
    await writeFile(join(checkout, 'index.js'), 'module.exports = (s) => s\n')
    await writeFile(join(checkout, 'Readme.md'), '> [!WARNING]\n> Unofficial patched fork.\n')
    const workflow = parse(
      previewWorkflow({
        fork: { owner: 'patchtogo-ai', repo: 'escape-html' },
        directory: '',
        readmePath: 'Readme.md',
        publishedAt: null
      })
    ) as Workflow
    const { env, steps } = workflow.jobs.build
    const runner = {
      PATH: process.env.PATH ?? '',
      HOME: root,
      npm_config_cache: join(root, 'npm-cache'),
      npm_config_offline: 'true',
      RUNNER_TEMP: join(root, 'runner'),
      GITHUB_SHA: commit,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'patchtogo-ai/escape-html',
      ...env
    }

    for (const step of steps) {
      if (step.run) {
        await run('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
          cwd: checkout,
          env: runner
        })
      }
    }

    const packed = join(root, 'runner', 'preview')
    const tarballs = await readdir(packed)
    expect(tarballs).toEqual(['patchtogo.ai-escape-html-1.0.3-ptg.1.preview-0123456.tgz'])
    await run('tar', ['-xzf', join(packed, tarballs[0] ?? ''), '-C', root])
    const manifest = JSON.parse(await readFile(join(root, 'package', 'package.json'), 'utf8'))
    expect(manifest).toMatchObject({
      name: '@patchtogo.ai/escape-html',
      version: '1.0.3-ptg.1.preview-0123456'
    })
    expect(await readFile(join(root, 'package', 'Readme.md'), 'utf8')).toBe(
      [
        '> [!CAUTION]',
        '> **Unreviewed preview.** `@patchtogo.ai/escape-html@1.0.3-ptg.1.preview-0123456` was built from commit [0123456](https://github.com/patchtogo-ai/escape-html/commit/' +
          commit +
          ') of an open patchtogo pull request. The patch was written by an AI agent and has not been reviewed yet: use this build only as an emergency stopgap until a reviewed release is published.',
        '',
        '> [!WARNING]',
        '> Unofficial patched fork.',
        ''
      ].join('\n')
    )
  })

  it('refuses a package directory that could break out of the workflow', () => {
    for (const directory of ['packages/${{ github.token }}', '../elsewhere', 'a b']) {
      expect(() =>
        previewWorkflow({
          fork: { owner: 'patchtogo-ai', repo: 'escape-html' },
          directory,
          readmePath: 'README.md',
          publishedAt: null
        })
      ).toThrow(/cannot use the directory/)
    }
  })
})
