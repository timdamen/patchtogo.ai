import { describe, expect, it } from 'vitest'
import { requestRetry } from '../src/operator.ts'
import type { Automation } from '../src/pipeline/automation.ts'
import type { PipelineEvent } from '../src/pipeline/events.ts'
import type { Pipeline } from '../src/pipeline/pipeline.ts'
import {
  advisory,
  fixedIndex,
  fixResult,
  fork,
  ghsaId,
  patchBranch,
  regressionTest,
  runId,
  setupPatchRun
} from './fakes/escape-html-fix.ts'
import type { InMemoryGitHub } from './fakes/github.ts'
import type { FakeRegistry } from './fakes/registry.ts'
import { stores } from './support/stores.ts'

const upstreamRepo = { owner: 'component', repo: 'escape-html' }
const upstreamBranch = 'ptg/upstream/escape-html/1.0.3/ghsa-gxr4-xjj5-5px2'
const compareUrl = `https://github.com/component/escape-html/compare/main...patchtogo-ai:escape-html:${upstreamBranch}?expand=1`
const patchPrUrl = 'https://github.com/patchtogo-ai/escape-html/pull/1'
const upstreamPrUrl = 'https://github.com/component/escape-html/pull/1'
const deprecate = `npm deprecate '@patchtogo.ai/escape-html@1.0.3-ptg.1' 'Superseded: escape-html@1.0.4 fixes ${ghsaId}. Remove the patchtogo override and use escape-html 1.0.4 or later.'`

function shipUpstream(
  test: { registry: FakeRegistry; github: InMemoryGitHub; pipeline: Pipeline },
  version: string,
  vulnerability: { vulnerableRange: string; patchedVersion: string | null }
) {
  test.registry.publish('escape-html', version)
  test.github.publishAdvisory({
    ...advisory,
    vulnerabilities: [{ ecosystem: 'npm', packageName: 'escape-html', ...vulnerability }]
  })
  return test.pipeline.handle({
    type: 'upstream-version-published',
    packageName: 'escape-html',
    version
  })
}

describe.each(stores)('upstreaming and superseding on the %s store', (_name, createStore) => {
  async function released({
    upstreamAccount = false,
    releaseAt = 'full' as Automation,
    beforeMerge = (_test: Awaited<ReturnType<typeof setupPatchRun>>) => {}
  } = {}) {
    const test = await setupPatchRun(await createStore(), [fixResult()], 'full', {
      upstreamAccount
    })
    test.registry.publish('@patchtogo.ai/escape-html', '0.0.0-ptg.0')
    await test.publish()
    beforeMerge(test)
    const pipeline: Pipeline = test.withAutomation(releaseAt)
    const commit = test.github.mergePullRequest(fork, 1)
    await pipeline.handle({
      type: 'pull-request-closed',
      pullRequest: { repository: fork, number: 1, head: patchBranch },
      mergeCommit: commit
    })
    test.registry.publish('@patchtogo.ai/escape-html', '1.0.3-ptg.1', { gitHead: commit })
    await pipeline.handle({
      type: 'stable-release-completed',
      repository: fork,
      headRepository: fork,
      trigger: 'push',
      branch: 'ptg/base/escape-html/1.0.3',
      commit,
      workflowRun: {
        id: 7,
        url: 'https://github.com/patchtogo-ai/escape-html/actions/runs/7',
        conclusion: 'success'
      }
    })

    const queue = {
      send: (event: PipelineEvent) => test.pipeline.handle(event),
      retryFailedJobs: async () => 0,
      failedKeys: async () => []
    }
    const operatorRetry = () => requestRetry(runId, { store: test.store, queue })
    const upstreamCommit = () => {
      const sha = test.github.repository(fork)?.branches.get(upstreamBranch)
      return sha ? test.github.commits.get(sha) : undefined
    }
    const upstreamPullRequests = () =>
      test.github.pullRequests.filter((pr) => pr.repo === 'component/escape-html')
    const notified = () => test.notifier.notifications.map((n) => n.type)
    return { ...test, operatorRetry, upstreamCommit, upstreamPullRequests, notified }
  }

  describe('the upstream pull request', () => {
    it('pushes only the fix and its regression test on top of the upstream release', async () => {
      const test = await released()

      const commit = test.upstreamCommit()
      expect(commit?.parent).toBe(test.upstream.sha)
      const release = test.github.commits.get(test.upstream.sha)?.files ?? {}
      const changed = Object.fromEntries(
        Object.entries(commit?.files ?? {}).filter(([path, content]) => release[path] !== content)
      )
      expect(changed).toEqual({ 'index.js': fixedIndex, 'test/ghsa.js': regressionTest })
      expect(Object.keys(commit?.files ?? {}).toSorted()).toEqual(
        [...Object.keys(release), 'test/ghsa.js'].toSorted()
      )
      expect(commit?.message).toMatch(/^fix: close GHSA-gxr4-xjj5-5px2 \(CVE-2099-0001\)\n\n/)
      expect(commit?.message).toContain(patchPrUrl)
      expect(commit?.message).toContain('`@patchtogo.ai/escape-html@1.0.3-ptg.1`')
      expect(commit?.message).not.toContain(advisory.description)
    })

    it('without an upstream token, hands the operator a compare URL and waits in released until the pull request is open', async () => {
      const test = await released()

      expect(await test.run()).toMatchObject({
        state: 'released',
        upstream: { compareUrl, notified: true, pullRequest: null }
      })
      expect(test.notifier.notifications.at(-1)).toEqual({
        type: 'upstream-pr-ready',
        runId,
        ghsaId,
        packageName: 'escape-html',
        compareUrl
      })

      await test.operatorRetry()

      expect((await test.run())?.state).toBe('released')
      expect(test.notified()).toEqual(['patch-pr-opened', 'upstream-pr-ready'])

      await test.github.upstreamAccount().openPullRequest(upstreamRepo, {
        head: `patchtogo-ai:${upstreamBranch}`,
        base: 'main',
        title: 'fix: close GHSA-gxr4-xjj5-5px2 (CVE-2099-0001)',
        body: 'opened by the operator'
      })
      await test.operatorRetry()

      expect(await test.run()).toMatchObject({
        state: 'upstreamed',
        upstream: { pullRequest: { number: 1, url: upstreamPrUrl } }
      })
      expect(test.notified()).toEqual(['patch-pr-opened', 'upstream-pr-ready'])
    })

    it('with an upstream token, opens the pull request from the fork and moves to upstreamed once', async () => {
      const test = await released({ upstreamAccount: true })

      expect(await test.run()).toMatchObject({
        state: 'upstreamed',
        upstream: { pullRequest: { number: 1, url: upstreamPrUrl } }
      })
      expect(test.upstreamPullRequests()).toEqual([
        expect.objectContaining({
          head: `patchtogo-ai:${upstreamBranch}`,
          base: 'main',
          title: 'fix: close GHSA-gxr4-xjj5-5px2 (CVE-2099-0001)',
          body: expect.stringContaining(patchPrUrl)
        })
      ])
      expect(test.notifier.notifications.at(-1)).toMatchObject({
        type: 'upstream-pr-opened',
        url: upstreamPrUrl
      })

      await test.retry()

      expect(test.upstreamPullRequests()).toHaveLength(1)
      expect(test.notified().filter((type) => type === 'upstream-pr-opened')).toHaveLength(1)
    })

    it.each([
      [
        'changed a file of the fix',
        { 'index.js': 'module.exports = (s) => s.trim()\n' },
        'index.js'
      ],
      ['added a file', { 'extra.js': 'module.exports = 1\n' }, 'extra.js']
    ])('proposes nothing upstream when a human %s before the merge', async (_case, files, path) => {
      const test = await released({
        upstreamAccount: true,
        beforeMerge: (setup) => setup.github.pushCommit(fork, patchBranch, 'human edit', files)
      })

      const run = await test.run()
      expect(run?.state).toBe('released')
      expect(run?.upstream?.blocked).toContain(path)
      expect(test.upstreamCommit()).toBeUndefined()
      expect(test.upstreamPullRequests()).toEqual([])
      expect(test.notifier.notifications.at(-1)).toMatchObject({
        type: 'upstream-pr-blocked',
        reason: run?.upstream?.blocked
      })

      await test.operatorRetry()

      expect(test.notified().filter((type) => type === 'upstream-pr-blocked')).toHaveLength(1)
    })

    it('waits in released below full automation and proposes upstream once the level is raised', async () => {
      const test = await released({ upstreamAccount: true, releaseAt: 'fork' })

      expect((await test.run())?.state).toBe('released')
      expect(test.upstreamCommit()).toBeUndefined()

      await test.operatorRetry()

      expect((await test.run())?.state).toBe('upstreamed')
      expect(test.upstreamPullRequests()).toHaveLength(1)
    })
  })

  describe('superseding', () => {
    it.each([
      ['released', false],
      ['upstreamed', true]
    ])(
      'marks a %s run superseded when upstream ships the fix, with the npm deprecate command',
      async (state, upstreamAccount) => {
        const test = await released({ upstreamAccount })
        expect((await test.run())?.state).toBe(state)

        await shipUpstream(test, '1.0.4', { vulnerableRange: '< 1.0.4', patchedVersion: '1.0.4' })

        expect(await test.run()).toMatchObject({
          state: 'superseded',
          superseded: { version: '1.0.4', command: deprecate }
        })
        expect(test.notifier.notifications.at(-1)).toEqual({
          type: 'superseded',
          runId,
          ghsaId,
          packageName: 'escape-html',
          version: '1.0.4',
          command: deprecate
        })

        await shipUpstream(test, '1.0.4', { vulnerableRange: '< 1.0.4', patchedVersion: '1.0.4' })

        expect(test.notified().filter((type) => type === 'superseded')).toHaveLength(1)
      }
    )

    it('keeps the run released until the deprecate command reached the reviewer channel', async () => {
      const test = await released()
      const before = await test.run()
      const fixed = { vulnerableRange: '< 1.0.4', patchedVersion: '1.0.4' }
      test.notifier.failNext()

      await expect(shipUpstream(test, '1.0.4', fixed)).rejects.toThrow('reviewer channel is down')

      expect(await test.run()).toEqual(before)

      await shipUpstream(test, '1.0.4', fixed)

      expect((await test.run())?.state).toBe('superseded')
      expect(test.notifier.notifications.at(-1)).toMatchObject({
        type: 'superseded',
        command: deprecate
      })
    })

    it.each([
      ['the advisory names no patched version yet', '1.0.4', '<= 1.0.3', null],
      ['the new version is still vulnerable', '1.0.4', '< 1.0.5', '1.0.5']
    ])('keeps watching when %s', async (_case, version, vulnerableRange, patchedVersion) => {
      const test = await released()
      const before = await test.run()

      await shipUpstream(test, version, { vulnerableRange, patchedVersion })

      expect(await test.run()).toEqual(before)
      expect(test.notified()).not.toContain('superseded')
    })
  })
})
