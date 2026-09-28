import { describe, expect, it } from 'vitest'
import type { SecurityAdvisory } from '../src/advisory.ts'
import type { Triage } from '../src/triage.ts'
import { matchingPackage } from './fakes/builder.ts'
import { createTestPipeline } from './fakes/pipeline.ts'
import { packageJson, seedUpstream, upstreamFiles, type UpstreamPackage } from './fakes/upstream.ts'
import { stores } from './support/stores.ts'

const ghsaId = 'GHSA-gxr4-xjj5-5px2'
const fork = { owner: 'patchtogo-ai', repo: 'escape-html' }
const upstream = { owner: 'component', repo: 'escape-html' }
const baseBranch = 'ptg/base/escape-html/1.0.3'

const patch: Triage = {
  decision: 'patch',
  reason: 'No patched version exists and the fix is local.',
  suspectedFiles: ['index.js'],
  fixStrategy: 'Escape the missing character.'
}

function advisory(packageNames: string[], vulnerableRange = '<= 1.0.3'): SecurityAdvisory {
  return {
    ghsaId,
    cveId: null,
    summary: 'XSS in escape-html',
    description: 'untrusted advisory text',
    severity: 'moderate',
    vulnerabilities: packageNames.map((packageName) => ({
      ecosystem: 'npm',
      packageName,
      vulnerableRange,
      patchedVersion: null
    }))
  }
}

const escapeHtml: UpstreamPackage = { name: 'escape-html', version: '1.0.3', repository: upstream }

describe.each(stores)('forking and the base branch on the %s store', (_name, createStore) => {
  async function setup() {
    const test = createTestPipeline({ store: await createStore(), triage: () => patch })
    async function run(packageNames = ['escape-html'], range?: string) {
      test.github.publishAdvisory(advisory(packageNames, range))
      await test.pipeline.handle({ type: 'advisory-published', ghsaId })
      return test.store.getRun(`${ghsaId}:${packageNames[0]}`)
    }
    return { ...test, run }
  }

  describe('happy path', () => {
    it('forks the upstream repository and cuts a scaffolded base branch at the release', async () => {
      const test = await setup()
      const { sha } = seedUpstream(test.github, test.registry, escapeHtml)

      const run = await test.run()

      expect(run).toMatchObject({
        state: 'fixing',
        release: {
          version: '1.0.3',
          repository: upstream,
          directory: '',
          commit: { sha, ref: 'v1.0.3' }
        },
        fork,
        baseBranch: { name: baseBranch }
      })
      expect(test.notifier.notifications).toEqual([])
      const forked = test.github.repository(fork)
      expect(forked).toMatchObject({ parent: upstream, defaultBranch: baseBranch })
      expect([...(forked?.branches.keys() ?? [])]).toEqual([baseBranch])
      expect(forked?.actionsEnabled).toBe(true)
      expect(forked?.teams.get('reviewers')).toBe('push')
      expect(test.builder.requests).toEqual([
        {
          runId: `${ghsaId}:escape-html`,
          source: { repository: 'patchtogo-ai/escape-html', branch: sha },
          directory: '',
          tarball: {
            url: 'https://registry.npmjs.org/escape-html/-/escape-html-1.0.3.tgz',
            integrity: null
          },
          publishedAt: '2020-01-01T00:00:00.000Z'
        }
      ])
    })

    it('puts every scaffolding change into one commit on top of the release commit', async () => {
      const test = await setup()
      const { sha } = seedUpstream(test.github, test.registry, escapeHtml)

      const run = await test.run()

      const head = test.github.commits.get(run?.baseBranch?.sha ?? '')
      expect(head?.parent).toBe(sha)
      expect(head?.message).toMatch(/^chore: patchtogo scaffolding for escape-html@1\.0\.3\n/)
      expect(head?.message).toContain(`Patchtogo-Upstream: component/escape-html@${sha}`)
      const files = head?.files ?? {}
      expect(JSON.parse(files['package.json'] ?? '')).toEqual({
        name: '@patchtogo.ai/escape-html',
        version: '1.0.3-ptg.1',
        main: 'index.js',
        files: ['index.js', 'PATCHTOGO.md'],
        repository: { type: 'git', url: 'git+https://github.com/patchtogo-ai/escape-html.git' },
        publishConfig: { access: 'public' }
      })
      expect(files['package.json']).toMatch(/^\{\n {2}"name"[\s\S]*\}\n$/)
      expect(files['README.md']).toMatch(/^> \[!WARNING\]\n> \*\*Unofficial patched fork\.\*\*/)
      expect(files['README.md']).toContain('https://github.com/component/escape-html')
      expect(files['README.md']).toContain('# escape-html\n\nEscapes HTML.\n')
      expect(files['PATCHTOGO.md']).toContain('unofficial fork of the npm package `escape-html`')
      expect(files['PATCHTOGO.md']).toContain('The upstream licence text is in [LICENSE](LICENSE).')
      expect(files['.github/CODEOWNERS']).toBe('* @patchtogo-ai/reviewers\n')
      expect(Object.keys(files).filter((path) => path.startsWith('.github/workflows/'))).toEqual([])
      const upstreamFilesAtRelease = upstreamFiles('escape-html', '1.0.3')
      expect(files['index.js']).toBe(upstreamFilesAtRelease['index.js'])
      expect(files.LICENSE).toBe(upstreamFilesAtRelease.LICENSE)
    })

    it('names a scoped monorepo package after its scope and finds its package tag', async () => {
      const test = await setup()
      const mono = { owner: 'acme', repo: 'tools' }
      seedUpstream(test.github, test.registry, {
        name: '@acme/strings',
        version: '2.1.0',
        repository: mono,
        files: {
          'package.json': packageJson({ name: 'acme-monorepo', private: true }),
          'packages/strings/package.json': packageJson({ name: '@acme/strings', version: '2.1.0' }),
          'packages/strings/readme.markdown': 'Strings.\n',
          'packages/strings/index.js': 'export {}\n'
        },
        tags: ['@acme/strings@2.1.0'],
        published: {
          repository: { url: 'https://github.com/acme/tools', directory: './packages/strings/' }
        }
      })

      const run = await test.run(['@acme/strings'], '< 3.0.0')

      const scoped = { owner: 'patchtogo-ai', repo: 'acme__strings' }
      const name = 'ptg/base/acme__strings/2.1.0'
      expect(run).toMatchObject({
        state: 'fixing',
        release: { directory: 'packages/strings', commit: { ref: '@acme/strings@2.1.0' } },
        fork: scoped,
        baseBranch: { name }
      })
      expect(test.builder.requests[0]?.directory).toBe('packages/strings')
      const pkg = JSON.parse(
        test.github.fileAt(scoped, name, 'packages/strings/package.json') ?? ''
      ) as Record<string, unknown>
      expect(pkg).toMatchObject({
        name: '@patchtogo.ai/acme__strings',
        version: '2.1.0-ptg.1',
        repository: {
          type: 'git',
          url: 'git+https://github.com/patchtogo-ai/acme__strings.git',
          directory: 'packages/strings'
        }
      })
      expect(test.github.fileAt(scoped, name, 'packages/strings/readme.markdown')).toMatch(
        /^> \[!WARNING\][\s\S]*\n\nStrings\.\n$/
      )
      expect(test.github.fileAt(scoped, name, 'packages/strings/PATCHTOGO.md')).toContain(
        'ships no licence file'
      )
      expect(test.github.fileAt(scoped, name, 'package.json')).toContain('acme-monorepo')
    })

    it('patches the latest published version inside the vulnerable range', async () => {
      const test = await setup()
      seedUpstream(test.github, test.registry, { ...escapeHtml, tags: ['v1.0.3'] })
      for (const version of ['1.0.0', '1.1.0-beta.1', '2.0.0']) {
        test.registry.publish('escape-html', version)
      }

      const run = await test.run(['escape-html'], '>= 1.0.0, < 2.0.0')

      expect(run).toMatchObject({ state: 'fixing', release: { version: '1.0.3' } })
    })

    it('prefers the commit npm recorded over release tags', async () => {
      const test = await setup()
      const { sha } = seedUpstream(test.github, test.registry, { ...escapeHtml, tags: [] })
      const published = test.registry.packages.get('escape-html')?.versions[0]
      if (published) published.gitHead = sha

      const run = await test.run()

      expect(run).toMatchObject({ state: 'fixing', release: { commit: { sha, ref: sha } } })
    })
  })

  describe('needs a human', () => {
    const cases: [string, (test: Awaited<ReturnType<typeof setup>>) => void, RegExp][] = [
      ['the package is not on npm', () => {}, /npm has no package escape-html/],
      [
        'no published version is vulnerable',
        (test) => seedUpstream(test.github, test.registry, { ...escapeHtml, version: '2.0.0' }),
        /No published version of escape-html is in the vulnerable range <= 1\.0\.3/
      ],
      [
        'the release names no repository',
        (test) => test.registry.publish('escape-html', '1.0.3'),
        /escape-html@1\.0\.3 names no source repository/
      ],
      [
        'the repository is not on GitHub',
        (test) =>
          test.registry.publish('escape-html', '1.0.3', {
            repository: { url: 'git+https://gitlab.com/component/escape-html.git', directory: null }
          }),
        /repository outside GitHub: git\+https:\/\/gitlab\.com/
      ],
      [
        'the repository does not exist',
        (test) =>
          test.registry.publish('escape-html', '1.0.3', {
            repository: { url: 'https://github.com/component/escape-html', directory: null }
          }),
        /component\/escape-html, does not exist or is not public/
      ],
      [
        'no tag or commit matches the release',
        (test) => seedUpstream(test.github, test.registry, { ...escapeHtml, tags: ['v1.0.2'] }),
        /no commit or tag for escape-html@1\.0\.3 \(tried v1\.0\.3, 1\.0\.3, escape-html@1\.0\.3, escape-html-v1\.0\.3\)/
      ],
      [
        'the tagged commit holds a different package',
        (test) =>
          seedUpstream(test.github, test.registry, {
            ...escapeHtml,
            files: { 'package.json': packageJson({ name: 'lodash', version: '1.0.3' }) }
          }),
        /component\/escape-html at v1\.0\.3 holds the package lodash, not escape-html/
      ]
    ]

    it.each(cases)('when %s, without forking', async (_case, arrange, reason) => {
      const test = await setup()
      arrange(test)

      const run = await test.run()

      expect(run?.state).toBe('needs-human')
      expect(run?.reason).toMatch(reason)
      expect(test.github.forks()).toEqual([])
      expect(test.notifier.notifications).toEqual([
        {
          type: 'needs-human',
          runId: run?.id,
          ghsaId,
          packageName: 'escape-html',
          reason: run?.reason
        }
      ])
    })

    it('when the build does not match the npm tarball, leaving the fork without a base branch', async () => {
      const test = await setup()
      seedUpstream(test.github, test.registry, escapeHtml)
      test.builder.outcome = () => ({
        published: matchingPackage,
        built: {
          files: { ...matchingPackage.files, 'index.js': 'different' },
          packageJson: { ...(matchingPackage.packageJson as object), main: 'lib/index.js' }
        },
        log: 'npm pack'
      })

      const run = await test.run()

      expect(run?.state).toBe('needs-human')
      expect(run?.reason).toBe(
        'escape-html@1.0.3 built from patchtogo-ai/escape-html at v1.0.3 does not match the npm tarball: 2 differ (package.json (main), index.js).'
      )
      expect(test.notifier.notifications).toHaveLength(1)
      expect(test.github.repository(fork)?.branches.has(baseBranch)).toBe(false)
      expect(test.github.repository(fork)?.actionsEnabled).toBe(false)
    })

    it('when the fork does not build', async () => {
      const test = await setup()
      seedUpstream(test.github, test.registry, escapeHtml)
      test.builder.outcome = () => ({
        published: matchingPackage,
        built: null,
        log: 'exit 1\nnpm ERR! missing script: build'
      })

      const run = await test.run()

      expect(run?.state).toBe('needs-human')
      expect(run?.reason).toMatch(/failed to build:\nexit 1\nnpm ERR! missing script: build$/)
      expect(test.notifier.notifications).toHaveLength(1)
    })
  })

  describe('idempotency', () => {
    it('treats a replayed advisory as a no-op once the base branch exists', async () => {
      const test = await setup()
      seedUpstream(test.github, test.registry, escapeHtml)

      const first = await test.run()
      const commits = test.github.commits.size
      const second = await test.run()

      expect(second).toEqual(first)
      expect(test.github.forks()).toHaveLength(1)
      expect(test.github.commits.size).toBe(commits)
      expect(test.builder.requests).toHaveLength(1)
    })

    it('reuses the fork when the base branch commit fails and the run is retried', async () => {
      const test = await setup()
      seedUpstream(test.github, test.registry, escapeHtml)
      test.github.failNext('createBranch', new Error('GitHub is down'))

      const failed = await test.run()
      expect(failed).toMatchObject({
        state: 'failed',
        failure: { step: 'verifying', error: 'GitHub is down' }
      })
      await test.pipeline.handle({ type: 'retry-requested', runId: failed?.id ?? '' })

      expect(await test.store.getRun(failed?.id ?? '')).toMatchObject({
        state: 'fixing',
        baseBranch: { name: baseBranch }
      })
      expect(test.github.forks()).toHaveLength(1)
      expect(test.github.calls.filter((c) => c.method === 'forkRepository')).toHaveLength(1)
    })

    it('does not rebuild or recommit when the base branch already exists on retry', async () => {
      const test = await setup()
      seedUpstream(test.github, test.registry, escapeHtml)
      test.github.failNext('setDefaultBranch')

      const failed = await test.run()
      expect(failed?.state).toBe('failed')
      const commits = test.github.commits.size
      await test.pipeline.handle({ type: 'retry-requested', runId: failed?.id ?? '' })

      const run = await test.store.getRun(failed?.id ?? '')
      expect(run?.state).toBe('fixing')
      expect(test.builder.requests).toHaveLength(1)
      expect(test.github.commits.size).toBe(commits)
      expect(test.github.repository(fork)?.defaultBranch).toBe(baseBranch)
    })

    it('shares one fork between packages from the same repository', async () => {
      const test = await setup()
      const mono = { owner: 'acme', repo: 'tools' }
      const files = {
        'packages/a/package.json': packageJson({ name: '@acme/a', version: '1.0.0' }),
        'packages/b/package.json': packageJson({ name: '@acme/b', version: '1.0.0' })
      }
      for (const name of ['@acme/a', '@acme/b']) {
        test.registry.publish(name, '1.0.0', {
          repository: {
            url: 'github:acme/tools',
            directory: `packages/${name.slice('@acme/'.length)}`
          }
        })
      }
      test.github.addRepository(mono, { files, tags: ['@acme/a@1.0.0', '@acme/b@1.0.0'] })

      await test.run(['@acme/a', '@acme/b'], '*')

      const runs = await test.store.listRuns({ ghsaId })
      expect(runs.map((run) => [run.packageName, run.state, run.fork])).toEqual([
        ['@acme/a', 'fixing', { owner: 'patchtogo-ai', repo: 'acme__a' }],
        ['@acme/b', 'fixing', { owner: 'patchtogo-ai', repo: 'acme__a' }]
      ])
      const shared = test.github.repository({ owner: 'patchtogo-ai', repo: 'acme__a' })
      expect([...(shared?.branches.keys() ?? [])].toSorted()).toEqual([
        'ptg/base/acme__a/1.0.0',
        'ptg/base/acme__b/1.0.0'
      ])
      expect(test.github.forks()).toHaveLength(1)
    })
  })
})
