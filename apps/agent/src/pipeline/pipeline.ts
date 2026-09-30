import { npmAdvisories } from '../advisory.ts'
import { patchedPackageName } from '../naming.ts'
import { triageAdvisory, type Triage } from '../triage.ts'
import type { Automation } from './automation.ts'
import { sameRepository } from '../upstream.ts'
import type {
  PipelineEvent,
  PullRequestClosed,
  PullRequestFeedback,
  StableReleaseCompleted,
  UpstreamVersionPublished
} from './events.ts'
import { isPatchedPackage, securityCoverage } from './coverage.ts'
import { fixingSteps } from './fixing.ts'
import { forkingSteps, type ForkSettings } from './forking.ts'
import { reviewLoop } from './review.ts'
import {
  IllegalTransitionError,
  isTerminal,
  retry,
  transition,
  type PatchRun,
  type RunState,
  type Step,
  type Transition
} from './patch-run.ts'
import { StaleRunError, type Ports, type RepoRef } from './ports.ts'
import { releasingSteps } from './releasing.ts'
import { supersedingCheck, watchedRuns } from './superseding.ts'
import { upstreamingSteps } from './upstreaming.ts'

export interface Pipeline {
  handle(event: PipelineEvent): Promise<void>
}

export interface PipelineSettings extends ForkSettings {
  automation: Automation
}

const triageOutcomes = {
  patch: 'forking',
  skip: 'skipped',
  'needs-human': 'needs-human'
} as const satisfies Record<Triage['decision'], RunState>

const releaseStates: readonly RunState[] = ['approved', 'failed', 'needs-human']

export function createPipeline(ports: Ports, settings: PipelineSettings): Pipeline {
  const { github, store, notifier, clock } = ports
  const review = reviewLoop(ports, settings)
  const supersededBy = supersedingCheck(ports, settings)
  const coverage = securityCoverage(ports, settings)
  const releasing = releasingSteps(ports, settings)

  const steps: Partial<Record<RunState, Step>> = {
    async detected(run) {
      const { triage, usage } = await triageAdvisory(
        ports,
        run.advisory,
        run.basedOn && run.release
          ? {
              name: patchedPackageName(run.packageName, settings),
              version: run.basedOn.version,
              upstreamVersion: run.release.version
            }
          : undefined
      )
      if (usage) {
        await store.recordCost({
          runId: run.id,
          step: run.state,
          ...usage,
          costUsd: null,
          sandboxSeconds: 0,
          at: clock.now()
        })
      }
      return { to: 'triaged', reason: triage.reason, details: { triage } }
    },
    async triaged(run) {
      if (!run.triage) throw new Error(`patch run ${run.id} has no triage`)
      const to = triageOutcomes[run.triage.decision]
      if (to === 'forking' && settings.automation === 'triage-only') return undefined
      return { to, reason: run.triage.reason }
    },
    ...forkingSteps(ports, settings),
    ...(settings.automation === 'full' ? fixingSteps(ports, settings) : {}),
    'in-review': review.step,
    approved: coverage.reportOnRelease(releasing.approved),
    ...(settings.automation === 'full' ? upstreamingSteps(ports, settings) : {})
  }

  async function attempt(step: Step, run: PatchRun): Promise<Transition | undefined> {
    try {
      const next = await step(run)
      if (next?.to === 'needs-human') {
        await notifier.notify({
          type: 'needs-human',
          runId: run.id,
          ghsaId: run.ghsaId,
          packageName: run.packageName,
          reason: next.reason ?? 'no reason given'
        })
      }
      return next
    } catch (error) {
      return { to: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async function save(run: PatchRun): Promise<boolean> {
    try {
      await store.saveRun(run)
      return true
    } catch (error) {
      if (error instanceof StaleRunError) return false
      throw error
    }
  }

  async function advance(run: PatchRun): Promise<void> {
    let current = run
    for (let step = steps[current.state]; step; step = steps[current.state]) {
      const next = await attempt(step, current)
      if (!next) return
      const updated = transition(current, next, clock.now())
      if (!(await save(updated))) return
      current = updated
    }
  }

  async function move(run: PatchRun, next: Transition): Promise<void> {
    const updated = transition(run, next, clock.now())
    if (await save(updated)) await advance(updated)
  }

  async function resumeFailed(run: PatchRun): Promise<PatchRun | undefined> {
    if (run.state !== 'failed') return run
    const next = retry(run, clock.now())
    return (await save(next)) ? next : undefined
  }

  async function runsOf(
    repository: RepoRef,
    states: readonly RunState[],
    matches: (run: PatchRun) => boolean
  ): Promise<PatchRun[]> {
    const runs: PatchRun[] = []
    for (const state of states) runs.push(...(await store.listRuns({ state })))
    return runs.filter((run) => run.fork && sameRepository(run.fork, repository) && matches(run))
  }

  async function pullRequestClosed({ pullRequest, mergeCommit }: PullRequestClosed): Promise<void> {
    const run = await review.runFor(pullRequest)
    if (!run || run.stable) return
    const state = run.state === 'failed' ? run.failure?.step : run.state
    const url = run.pullRequest?.url
    if (mergeCommit ? state !== 'in-review' && state !== 'needs-human' : state !== 'in-review') {
      return
    }
    const current = await resumeFailed(run)
    if (!current) return
    if (mergeCommit) {
      return move(current, {
        to: 'approved',
        reason: `${url} was merged as ${mergeCommit}; waiting for the stable release workflow.`,
        details: { stable: { commit: mergeCommit } }
      })
    }
    const reason = `${url} was closed without being merged, so the agent stopped working on it. Reopening the PR does not resume the run.`
    await move(current, { to: 'needs-human', reason })
    await notifier.notify({
      type: 'needs-human',
      runId: run.id,
      ghsaId: run.ghsaId,
      packageName: run.packageName,
      reason
    })
  }

  async function stableReleaseCompleted(event: StableReleaseCompleted): Promise<void> {
    const { repository, workflowRun } = event
    if (event.trigger !== 'push' || !sameRepository(event.headRepository, repository)) return
    const succeeded = workflowRun.conclusion === 'success'
    const runs = await runsOf(
      repository,
      releaseStates,
      (run) => run.baseBranch?.name === event.branch && run.stable?.commit === event.commit
    )
    for (const run of runs) {
      const waiting = run.state === 'approved'
      const heldBack = run.state === 'needs-human' || run.failure?.step === 'approved'
      if (!waiting && !(succeeded && heldBack)) continue
      const current = await resumeFailed(run)
      if (!current?.stable) continue
      await move(current, {
        to: 'approved',
        reason: `The stable release workflow ended with ${workflowRun.conclusion}: ${workflowRun.url}`,
        details: { stable: { ...current.stable, workflow: workflowRun } }
      })
    }
  }

  async function upstreamVersionPublished({
    packageName,
    version
  }: UpstreamVersionPublished): Promise<void> {
    for (const run of await watchedRuns(store, packageName)) {
      const next = await supersededBy(run, version)
      if (!next?.details?.superseded) continue
      const current = await resumeFailed(run)
      if (!current) continue
      if (!(await save(transition(current, next, clock.now())))) continue
      await notifier.notify({
        type: 'superseded',
        runId: run.id,
        ghsaId: run.ghsaId,
        packageName: run.packageName,
        ...next.details.superseded
      })
    }
  }

  async function advisoryPublished(ghsaId: string): Promise<void> {
    const advisory = await github.getAdvisory(ghsaId)
    if (!advisory) return
    const failures: unknown[] = []
    for (const packageAdvisory of npmAdvisories(advisory)) {
      if (isPatchedPackage(packageAdvisory.packageName, settings)) continue
      const covered = await coverage.check(packageAdvisory)
      try {
        await coverage.report(covered)
      } catch (error) {
        failures.push(error)
      }
      await advance(await store.createRunIfAbsent(coverage.newRun(covered, clock.now())))
    }
    if (failures.length > 0) throw failures[0]
  }

  async function retryRequested(id: string): Promise<void> {
    const run = await store.getRun(id)
    if (!run) throw new Error(`no patch run ${id}`)
    if (run.state === 'needs-human' && run.stable) {
      return move(run, {
        to: 'approved',
        reason: 'The operator resumed the release.',
        details: { stable: { commit: run.stable.commit } }
      })
    }
    if (run.state !== 'failed') {
      if (run.state === 'needs-human' || isTerminal(run.state)) {
        throw new IllegalTransitionError(
          `patch run ${run.id} is ${run.state}, so it cannot be retried`
        )
      }
      return advance(run)
    }
    const resumed = retry(run, clock.now())
    if (await save(resumed)) await advance(resumed)
  }

  async function feedbackReceived(event: PullRequestFeedback): Promise<void> {
    const recorded = await review.record(event)
    if (recorded?.iterate) await advance(recorded.run)
  }

  return {
    async handle(event) {
      switch (event.type) {
        case 'advisory-published':
          return advisoryPublished(event.ghsaId)
        case 'retry-requested':
          return retryRequested(event.runId)
        case 'pull-request-commented':
        case 'review-submitted':
        case 'review-comment-created':
        case 'pull-request-labeled':
          return feedbackReceived(event)
        case 'pull-request-closed':
          return pullRequestClosed(event)
        case 'stable-release-completed':
          return stableReleaseCompleted(event)
        case 'upstream-version-published':
          return upstreamVersionPublished(event)
      }
    }
  }
}
