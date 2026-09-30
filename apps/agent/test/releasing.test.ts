import { describe, expect, it } from 'vitest'
import { requestRetry } from '../src/operator.ts'
import type { PipelineEvent, StableReleaseCompleted } from '../src/pipeline/events.ts'
import { HAND_OVER_LABEL } from '../src/pipeline/review.ts'
import {
  baseBranch,
  fixResult,
  fork,
  ghsaId,
  patchBranch,
  runId,
  setupPatchRun
} from './fakes/escape-html-fix.ts'
import { stores } from './support/stores.ts'

const repository = 'patchtogo-ai/escape-html'
const pullRequest = { repository: fork, number: 1, head: patchBranch }
const patched = '@patchtogo.ai/escape-html'
const actionsRun = (id: number) => `https://github.com/${repository}/actions/runs/${id}`

function completed(
  commit: string,
  conclusion: string,
  overrides: Partial<StableReleaseCompleted> = {}
): StableReleaseCompleted {
  return {
    type: 'stable-release-completed',
    repository: fork,
    headRepository: fork,
    trigger: 'push',
    branch: baseBranch,
    commit,
    workflowRun: { id: 7, url: actionsRun(7), conclusion },
    ...overrides
  }
}

describe.each(stores)('stable release on the %s store', (_name, createStore) => {
  async function inReview({ bootstrapped = true } = {}) {
    const test = await setupPatchRun(await createStore(), [fixResult()])
    if (bootstrapped) test.registry.publish(patched, '0.0.0-ptg.0')
    await test.publish()
    expect((await test.run())?.state).toBe('in-review')

    const close = (mergeCommit: string | null) =>
      test.pipeline.handle({ type: 'pull-request-closed', pullRequest, mergeCommit })

    async function merge(): Promise<string> {
      const mergeCommit = test.github.mergePullRequest(fork, 1)
      await close(mergeCommit)
      return mergeCommit
    }

    const complete = (commit: string, conclusion: string) =>
      test.pipeline.handle(completed(commit, conclusion))
    const releaseOnNpm = (commit: string) =>
      test.registry.publish(patched, '1.0.3-ptg.1', { gitHead: commit })

    return { ...test, close, merge, complete, releaseOnNpm }
  }

  it('moves a merged patch PR to approved and a successful release to released', async () => {
    const test = await inReview()

    const commit = await test.merge()

    expect(await test.run()).toMatchObject({
      state: 'approved',
      reason: expect.stringContaining(`https://github.com/${repository}/pull/1 was merged`),
      stable: { commit }
    })

    test.releaseOnNpm(commit)
    await test.complete(commit, 'success')

    expect(await test.run()).toMatchObject({
      state: 'released',
      stable: {
        commit,
        version: '1.0.3-ptg.1',
        workflow: { id: 7, url: actionsRun(7), conclusion: 'success' }
      }
    })
    const events = await test.store.listEvents(runId)
    const releasedAt = events.findIndex((event) => event.state === 'released')
    expect(events[releasedAt]?.reason).toBe(`Published ${patched}@1.0.3-ptg.1 from ${commit}.`)
    expect(events.slice(releasedAt - 3, releasedAt + 1).map((event) => event.state)).toEqual([
      'in-review',
      'approved',
      'approved',
      'released'
    ])
    expect(test.notifier.notifications.map((n) => n.type)).toEqual([
      'patch-pr-opened',
      'upstream-pr-ready'
    ])
  })

  it('fails at the approved step when the release workflow fails, and resumes when a re-run succeeds', async () => {
    const test = await inReview()
    const commit = await test.merge()

    await test.complete(commit, 'failure')

    expect(await test.run()).toMatchObject({
      state: 'failed',
      failure: {
        step: 'approved',
        error: expect.stringContaining(`ended with failure: ${actionsRun(7)}`)
      }
    })

    test.releaseOnNpm(commit)
    await test.complete(commit, 'success')

    expect(await test.run()).toMatchObject({
      state: 'released',
      stable: { version: '1.0.3-ptg.1' }
    })
  })

  it('fails when a successful workflow left no version on npm, and a retry checks npm again', async () => {
    const test = await inReview()
    const commit = await test.merge()

    await test.complete(commit, 'success')

    expect(await test.run()).toMatchObject({
      state: 'failed',
      failure: {
        step: 'approved',
        error: expect.stringContaining(`npm shows no version of ${patched} built from ${commit}`)
      }
    })

    test.releaseOnNpm(commit)
    await test.retry()

    expect(await test.run()).toMatchObject({
      state: 'released',
      stable: { version: '1.0.3-ptg.1' }
    })
  })

  describe('the first release of a new package', () => {
    it('holds the run in needs-human with the operator steps until a re-run succeeds', async () => {
      const test = await inReview({ bootstrapped: false })

      const commit = await test.merge()

      const run = await test.run()
      expect(run?.state).toBe('needs-human')
      for (const step of [
        `npm pkg set name=${patched} version=0.0.0-ptg.0`,
        'npm publish --access public --tag bootstrap',
        `npm trust github ${patched} --repo ${repository} --file patchtogo-release.yml --environment patchtogo-release --allow-publish --yes`,
        `https://github.com/${repository}/actions/workflows/patchtogo-release.yml?query=branch%3Aptg%2Fbase%2Fescape-html%2F1.0.3`
      ]) {
        expect(run?.reason).toContain(step)
      }
      expect(test.notifier.notifications.at(-1)).toEqual({
        type: 'needs-human',
        runId,
        ghsaId,
        packageName: 'escape-html',
        reason: run?.reason
      })

      await test.complete(commit, 'failure')

      expect((await test.run())?.state).toBe('needs-human')
      expect(test.notifier.notifications).toHaveLength(2)

      test.registry.publish(patched, '0.0.0-ptg.0')
      test.releaseOnNpm(commit)
      await test.complete(commit, 'success')

      expect(await test.run()).toMatchObject({ state: 'released', stable: { commit } })
    })

    it("resumes through the operator's retry and waits for the re-run", async () => {
      const test = await inReview({ bootstrapped: false })
      const commit = await test.merge()
      test.registry.publish(patched, '0.0.0-ptg.0')
      const queued: PipelineEvent[] = []
      const queue = {
        send: async (event: PipelineEvent) => {
          queued.push(event)
        },
        retryFailedJobs: async () => 0,
        failedKeys: async () => []
      }

      expect(await requestRetry(runId, { store: test.store, queue })).toEqual({
        retriedJobs: 0,
        retriedRuns: [runId]
      })
      for (const event of queued) await test.pipeline.handle(event)

      expect((await test.run())?.state).toBe('approved')
      expect(test.notifier.notifications).toHaveLength(2)

      test.releaseOnNpm(commit)
      await test.complete(commit, 'success')

      expect((await test.run())?.state).toBe('released')
    })
  })

  it('ends the review loop in needs-human when the patch PR is closed without merging', async () => {
    const test = await inReview()

    await test.close(null)

    const run = await test.run()
    expect(run).toMatchObject({
      state: 'needs-human',
      reason: expect.stringContaining(
        `https://github.com/${repository}/pull/1 was closed without being merged`
      )
    })
    expect(test.notifier.notifications.at(-1)).toMatchObject({ type: 'needs-human', runId })
  })

  it('stays in review until the reviewer channel heard that the patch PR was closed', async () => {
    const test = await inReview()
    test.notifier.failNext()

    await expect(test.close(null)).rejects.toThrow('reviewer channel is down')

    expect((await test.run())?.state).toBe('in-review')

    await test.close(null)

    expect((await test.run())?.state).toBe('needs-human')
    expect(test.notifier.notifications.at(-1)).toMatchObject({ type: 'needs-human', runId })
  })

  it('releases a patch PR that humans merge after the agent handed it over', async () => {
    const test = await inReview()
    test.github.addTeamMember('patchtogo-ai', 'reviewers', 'alice')
    await test.pipeline.handle({
      type: 'pull-request-labeled',
      pullRequest,
      label: HAND_OVER_LABEL,
      sender: { login: 'alice', bot: false }
    })
    expect((await test.run())?.state).toBe('needs-human')

    const commit = await test.merge()

    expect(await test.run()).toMatchObject({ state: 'approved', stable: { commit } })
  })

  it.each([
    ['a workflow run another trigger started', { trigger: 'pull_request' }],
    [
      'a workflow run from another repository',
      { headRepository: { owner: 'mallory', repo: 'escape-html' } }
    ],
    ['a workflow run on another branch', { branch: 'ptg/base/escape-html/1.0.2' }],
    ['a workflow run for another commit', { commit: 'f'.repeat(40) }]
  ])('ignores %s', async (_case, overrides) => {
    const test = await inReview()
    const commit = await test.merge()
    const before = await test.run()

    await test.pipeline.handle({ ...completed(commit, 'failure'), ...overrides })

    expect(await test.run()).toEqual(before)
  })

  it('treats replayed merge and release deliveries as no-ops', async () => {
    const test = await inReview()
    const commit = await test.merge()
    test.releaseOnNpm(commit)
    await test.complete(commit, 'success')
    const released = await test.run()

    await test.close(commit)
    await test.complete(commit, 'failure')

    expect(await test.run()).toEqual(released)
  })
})
