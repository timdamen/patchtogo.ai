import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
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
const previewWorkflowPath = '.github/workflows/patchtogo-preview.yml'
const stableWorkflow = '.github/workflows/patchtogo-release.yml'

interface Workflow {
  on: unknown
  permissions: unknown
  jobs: Record<
    string,
    {
      if?: string
      needs?: string | string[]
      permissions?: unknown
      env?: Record<string, string>
      steps: { uses?: string; run?: string }[]
    }
  >
}

const patch: Triage = {
  decision: 'patch',
  reason: 'No patched version exists and the fix is local.',
  suspectedFiles: ['index.js'],
  fixStrategy: 'Escape the missing character.'
}

function advisory(packageNames: string[], vulnerableRange = '<= 1.0.3'): SecurityAdvisory {
  return {
    ghsaId,
    type: 'reviewed',
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

  async function olderBaseBranch() {
    const test = await setup()
    seedUpstream(test.github, test.registry, escapeHtml)
    test.github.failNext('setDefaultBranch')
    const failed = await test.run()
    const forked = test.github.repository(fork)
    const scaffolded = test.github.commits.get(forked?.branches.get(baseBranch) ?? '')
    const {
      [previewWorkflowPath]: preview,
      [stableWorkflow]: stable,
      ...older
    } = scaffolded?.files ?? {}
    const before = await test.github.createBranch(fork, {
      name: 'ptg/older-scaffolding',
      parent: scaffolded?.sha ?? '',
      message: 'a base branch scaffolded before the patchtogo workflows',
      changes: [
        { path: previewWorkflowPath, delete: true },
        { path: stableWorkflow, delete: true }
      ]
    })
    forked?.branches.set(baseBranch, before)
    forked?.branches.delete('ptg/older-scaffolding')
    const retry = () => test.pipeline.handle({ type: 'retry-requested', runId: failed?.id ?? '' })
    const run = () => test.store.getRun(failed?.id ?? '')
    const head = () => test.github.commits.get(forked?.branches.get(baseBranch) ?? '')
    return { ...test, before, older, workflows: { preview, stable }, retry, run, head }
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
      expect(files['README.md']).toContain(
        'patchtogo publishes [its own security advisories](https://github.com/patchtogo-ai/escape-html/security/advisories)'
      )
      expect(files['README.md']).toContain('# escape-html\n\nEscapes HTML.\n')
      expect(files['PATCHTOGO.md']).toContain('unofficial fork of the npm package `escape-html`')
      expect(files['PATCHTOGO.md']).toContain('The upstream licence text is in [LICENSE](LICENSE).')
      expect(files['.github/CODEOWNERS']).toBe('* @patchtogo-ai/reviewers\n')
      expect(
        Object.keys(files)
          .filter((path) => path.startsWith('.github/workflows/'))
          .toSorted()
      ).toEqual([previewWorkflowPath, stableWorkflow])
      const upstreamFilesAtRelease = upstreamFiles('escape-html', '1.0.3')
      expect(files['index.js']).toBe(upstreamFilesAtRelease['index.js'])
      expect(files.LICENSE).toBe(upstreamFilesAtRelease.LICENSE)
    })

    it('adds a preview workflow that publishes patch branch pushes in the fork without secrets', async () => {
      const test = await setup()
      seedUpstream(test.github, test.registry, escapeHtml)

      await test.run()

      const text = test.github.fileAt(fork, baseBranch, previewWorkflowPath) ?? ''
      const workflow = parse(text) as Workflow
      expect(workflow.on).toEqual({ push: { branches: ['ptg/patch/**'] } })
      expect(workflow.permissions).toEqual({})
      expect(text).not.toMatch(/secrets\.|id-token|pull_request/)
      const { build, publish } = workflow.jobs
      expect(Object.keys(workflow.jobs)).toEqual(['build', 'publish'])
      expect(build?.permissions).toEqual({ contents: 'read' })
      expect(publish?.permissions).toEqual({})
      for (const job of [build, publish]) {
        expect(job?.if).toBe("github.repository == 'patchtogo-ai/escape-html'")
        for (const step of job?.steps ?? []) {
          if (step.uses) expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
        }
      }
      expect(build?.env).toMatchObject({
        PTG_PACKAGE_DIR: '.',
        PTG_README: 'README.md',
        PTG_BEFORE: '2020-01-01T00:00:00.000Z'
      })
      expect(publish?.steps.at(-1)?.run).toMatch(
        /^npx --yes pkg-pr-new@\d+\.\d+\.\d+ publish .*\.\/preview\/\*\.tgz$/
      )
    })

    it('adds a stable release workflow in which only the publish job can get an OIDC token', async () => {
      const test = await setup()
      seedUpstream(test.github, test.registry, escapeHtml)

      await test.run()

      const text = test.github.fileAt(fork, baseBranch, stableWorkflow) ?? ''
      const workflow = parse(text) as Workflow
      expect(workflow.on).toEqual({ push: { branches: ['ptg/base/**'] } })
      expect(workflow.permissions).toEqual({})
      expect(Object.keys(workflow.jobs)).toEqual(['gate', 'build', 'publish'])
      const { gate, build, publish } = workflow.jobs
      expect(gate?.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
      expect(build?.permissions).toEqual({ contents: 'read' })
      expect(publish?.permissions).toEqual({ 'id-token': 'write' })
      expect(build?.needs).toBe('gate')
      expect(publish?.needs).toEqual(['gate', 'build'])
      for (const job of [gate, build, publish]) {
        expect(job?.if).toContain("github.repository == 'patchtogo-ai/escape-html'")
        expect(job?.if).toContain("startsWith(github.ref, 'refs/heads/ptg/base/')")
      }
      for (const job of [build, publish]) {
        expect(job?.if).toContain("needs.gate.outputs.release == 'true'")
      }
      expect(build?.env).toMatchObject({
        PTG_PACKAGE_NAME: '@patchtogo.ai/escape-html',
        PTG_UPSTREAM_VERSION: '1.0.3',
        PTG_PACKAGE_DIR: '.',
        PTG_BEFORE: '2020-01-01T00:00:00.000Z'
      })
      for (const job of [gate, publish]) {
        expect(job?.steps.some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(false)
      }
      const command = publish?.steps.at(-1)?.run ?? ''
      expect(command).toMatch(/^npm publish \.\/release\/\*\.tgz /)
      for (const flag of ['--provenance', '--access public', '--tag latest', '--ignore-scripts']) {
        expect(command).toContain(flag)
      }
      expect(text).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|_authToken|pull_request_target/)
      const actions = Object.values(workflow.jobs).flatMap((job) =>
        job.steps.flatMap((step) => (step.uses ? [step.uses] : []))
      )
      expect(actions.length).toBeGreaterThan(0)
      for (const action of actions) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
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
      const workflow = parse(
        test.github.fileAt(scoped, name, previewWorkflowPath) ?? ''
      ) as Workflow
      expect(workflow.jobs.build?.env).toMatchObject({
        PTG_PACKAGE_DIR: 'packages/strings',
        PTG_README: 'packages/strings/readme.markdown'
      })
      const stable = parse(test.github.fileAt(scoped, name, stableWorkflow) ?? '') as Workflow
      expect(stable.jobs.build?.env).toMatchObject({
        PTG_PACKAGE_NAME: '@patchtogo.ai/acme__strings',
        PTG_PACKAGE_DIR: 'packages/strings'
      })
    })

    it('patches the latest published version inside the vulnerable range', async () => {
      const test = await setup()
      seedUpstream(test.github, test.registry, { ...escapeHtml, tags: ['v1.0.3'] })
      for (const version of ['1.0.0', '1.1.0-beta.1', '2.0.0']) {
        test.registry.publish('escape-html', version)
      }
      test.registry.tagLatest('escape-html', '1.0.0')

      const run = await test.run(['escape-html'], '>= 1.0.0, < 2.0.0')

      expect(run).toMatchObject({ state: 'fixing', release: { version: '1.0.3' } })
    })

    it('prefers the commit npm recorded over release tags', async () => {
      const test = await setup()
      const { sha } = seedUpstream(test.github, test.registry, escapeHtml)
      const retagged = await test.github.createBranch(upstream, {
        name: 'retagged',
        parent: sha,
        message: 'a later commit the release tag was moved to',
        changes: []
      })
      test.github.repository(upstream)?.tags.set('v1.0.3', retagged)
      const published = test.registry.packages.get('escape-html')?.versions[0]
      if (published) published.gitHead = sha

      const run = await test.run()

      expect(run).toMatchObject({ state: 'fixing', release: { commit: { sha, ref: sha } } })
    })

    it('keeps the indentation and line endings of the upstream package.json', async () => {
      const test = await setup()
      seedUpstream(test.github, test.registry, {
        ...escapeHtml,
        files: {
          ...upstreamFiles('escape-html', '1.0.3'),
          'package.json': '{\r\n\t"name": "escape-html",\r\n\t"version": "1.0.3"\r\n}\r\n'
        }
      })

      await test.run()

      expect(test.github.fileAt(fork, baseBranch, 'package.json')).toBe(
        [
          '{',
          '\t"name": "@patchtogo.ai/escape-html",',
          '\t"version": "1.0.3-ptg.1",',
          '\t"repository": {',
          '\t\t"type": "git",',
          '\t\t"url": "git+https://github.com/patchtogo-ai/escape-html.git"',
          '\t},',
          '\t"publishConfig": {',
          '\t\t"access": "public"',
          '\t}',
          '}',
          ''
        ].join('\r\n')
      )
    })
  })

  describe('needs a human', () => {
    const cases: [string, (test: Awaited<ReturnType<typeof setup>>) => void, RegExp][] = [
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

    it('adds missing workflows to an unprotected base branch in one follow-up commit', async () => {
      const test = await olderBaseBranch()
      test.github.rulesets = []

      await test.retry()

      const head = test.head()
      expect(await test.run()).toMatchObject({
        state: 'fixing',
        baseBranch: { name: baseBranch, sha: head?.sha }
      })
      expect(head?.parent).toBe(test.before)
      expect(head?.message).toMatch(
        /^chore: update the patchtogo scaffolding for escape-html@1\.0\.3\n/
      )
      expect(head?.files).toEqual({
        ...test.older,
        [previewWorkflowPath]: test.workflows.preview,
        [stableWorkflow]: test.workflows.stable
      })
      expect(test.builder.requests).toHaveLength(1)
    })

    it('proposes missing workflows for a protected base branch in a pull request and waits for it', async () => {
      const test = await olderBaseBranch()

      await test.retry()

      const scaffoldingBranch = 'ptg/scaffolding/escape-html/1.0.3'
      expect(test.github.pullRequests).toMatchObject([
        { head: scaffoldingBranch, base: baseBranch, reviewTeams: ['reviewers'] }
      ])
      expect(await test.run()).toMatchObject({
        state: 'failed',
        failure: {
          step: 'verifying',
          error: expect.stringContaining(
            'is protected, so patchtogo opened https://github.com/patchtogo-ai/escape-html/pull/1'
          )
        }
      })
      expect(test.head()?.sha).toBe(test.before)
      expect(test.github.changedFiles(fork, baseBranch, scaffoldingBranch)).toEqual({
        [previewWorkflowPath]: test.workflows.preview,
        [stableWorkflow]: test.workflows.stable
      })

      const merged = test.github.mergePullRequest(fork, 1)
      await test.retry()

      expect(await test.run()).toMatchObject({
        state: 'fixing',
        baseBranch: { name: baseBranch, sha: merged }
      })
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

      await test.run(['@acme/a', '@acme/b'], '>= 0')

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
