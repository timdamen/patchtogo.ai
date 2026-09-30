import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { stableReleaseWorkflow } from '../src/stable-workflow.ts'

const run = promisify(execFile)

interface Step {
  run?: string
  env?: Record<string, string>
}

interface Workflow {
  jobs: Record<'gate' | 'build', { env?: Record<string, string>; steps: Step[] }>
}

const repository = 'patchtogo-ai/escape-html'
const merge = 'b'.repeat(40)
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

function pullRequest(head: string) {
  return {
    number: 1,
    merged_at: '2026-09-30T08:00:00Z',
    merge_commit_sha: merge,
    head: { ref: head, repo: { full_name: repository } }
  }
}

async function githubAndNpm(pulls: unknown[]): Promise<string> {
  const packument = {
    name: '@patchtogo.ai/escape-html',
    'dist-tags': { latest: '1.0.3-ptg.1', bootstrap: '0.0.0-ptg.0' },
    versions: Object.fromEntries(
      ['0.0.0-ptg.0', '1.0.3-ptg.1'].map((version) => [
        version,
        { name: '@patchtogo.ai/escape-html', version }
      ])
    )
  }
  const server: Server = createServer((request, response) => {
    const body =
      request.url === `/repos/${repository}/commits/${merge}/pulls`
        ? pulls
        : request.url?.toLowerCase() === '/@patchtogo.ai%2fescape-html'
          ? packument
          : undefined
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body ?? { error: 'not found' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(async () => {
    server.close()
    await once(server, 'close')
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function releaseJob(pulls: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'ptg-release-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'checkout')
  await mkdir(checkout)
  await writeFile(
    join(checkout, 'package.json'),
    JSON.stringify({ name: '@patchtogo.ai/escape-html', version: '1.0.3-ptg.1', main: 'index.js' })
  )
  await writeFile(
    join(checkout, 'index.js'),
    "module.exports = (s) => String(s).replaceAll('<', '&lt;')\n"
  )
  const server = await githubAndNpm(pulls)
  const workflow = parse(
    stableReleaseWorkflow({
      fork: { owner: 'patchtogo-ai', repo: 'escape-html' },
      packageName: '@patchtogo.ai/escape-html',
      upstreamVersion: '1.0.3',
      directory: '',
      publishedAt: null
    })
  ) as Workflow
  const output = join(root, 'output')
  await writeFile(output, '')
  const runner = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_registry: `${server}/`,
    RUNNER_TEMP: join(root, 'runner'),
    GITHUB_API_URL: server,
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: merge,
    GITHUB_OUTPUT: output
  }

  async function steps(job: 'gate' | 'build', env: Record<string, string> = {}) {
    for (const step of workflow.jobs[job].steps) {
      if (!step.run) continue
      await run('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
        cwd: checkout,
        env: { ...runner, ...workflow.jobs[job].env, ...step.env, ...env }
      })
    }
  }

  return {
    async gate() {
      await steps('gate', { GH_TOKEN: 'token' })
      return readFile(output, 'utf8')
    },
    async build() {
      await steps('build')
      const packed = join(root, 'runner', 'release')
      const tarballs = await readdir(packed)
      await run('tar', ['-xzf', join(packed, tarballs[0] ?? ''), '-C', root])
      return {
        tarballs,
        manifest: JSON.parse(await readFile(join(root, 'package', 'package.json'), 'utf8'))
      }
    }
  }
}

describe('stable release workflow', () => {
  it('packs the merge of a patch pull request as the next -ptg.N built from that commit', async () => {
    const job = await releaseJob([pullRequest('ptg/patch/escape-html/1.0.3/ghsa-gxr4-xjj5-5px2')])

    expect(await job.gate()).toBe('release=true\n')

    const { tarballs, manifest } = await job.build()
    expect(tarballs).toEqual(['patchtogo.ai-escape-html-1.0.3-ptg.2.tgz'])
    expect(manifest).toMatchObject({
      name: '@patchtogo.ai/escape-html',
      version: '1.0.3-ptg.2',
      gitHead: merge
    })
  })

  it('releases nothing for a push that merges no patch pull request', async () => {
    const job = await releaseJob([pullRequest('ptg/scaffolding/escape-html/1.0.3')])

    expect(await job.gate()).toBe('release=false\n')
  })
})
