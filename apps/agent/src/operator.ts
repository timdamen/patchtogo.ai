import {
  cannotResume,
  ghsaIdOf,
  needsHumanStep,
  type PatchRun,
  type RunState
} from './pipeline/patch-run.ts'
import type { Store } from './pipeline/ports.ts'
import type { PipelineQueue } from './queue.ts'
import { parseTestAdvisory } from './test-advisories.ts'

interface OperatorDeps {
  store: Store
  queue: Pick<PipelineQueue, 'send' | 'retryFailedJobs' | 'failedKeys'>
}

export interface RetryReport {
  retriedJobs: number
  retriedRuns: string[]
}

export interface Failures {
  runs: PatchRun[]
  held: PatchRun[]
  blockedAdvisories: string[]
}

function advisoryHeld(run: PatchRun): boolean {
  return run.repositoryAdvisory?.status === 'held'
}

const unfinishedStates: readonly RunState[] = [
  'detected',
  'triaged',
  'forking',
  'verifying',
  'fixing',
  'approved'
]

function resumable(run: PatchRun): boolean {
  return (
    run.state === 'failed' ||
    run.held !== undefined ||
    unfinishedStates.includes(run.state) ||
    (run.state === 'in-review' && (run.review?.instructions.length ?? 0) > 0) ||
    (run.state === 'needs-human' && run.stable !== undefined) ||
    run.state === 'released'
  )
}

function stranded(run: PatchRun): boolean {
  return (
    run.held === undefined &&
    unfinishedStates.includes(run.state) &&
    (run.state !== 'approved' || run.stable?.workflow !== undefined)
  )
}

export async function resumeStrandedRuns({
  store,
  queue
}: {
  store: Store
  queue: Pick<PipelineQueue, 'send' | 'hasOpenJob'>
}): Promise<string[]> {
  const resumed: string[] = []
  for (const state of unfinishedStates) {
    for (const run of await store.listRuns({ state })) {
      if (!stranded(run)) continue
      const retry = { type: 'retry-requested', runId: run.id } as const
      if (await queue.hasOpenJob(retry)) continue
      if ((await store.getRun(run.id))?.version !== run.version) continue
      await queue.send(retry)
      resumed.push(run.id)
    }
  }
  return resumed
}

export async function listFailures({ store, queue }: OperatorDeps): Promise<Failures> {
  return {
    runs: await store.listRuns({ state: 'failed' }),
    held: (await store.listRuns()).filter((run) => run.held !== undefined || advisoryHeld(run)),
    blockedAdvisories: await queue.failedKeys()
  }
}

export async function requestRetry(
  target: string,
  { store, queue }: OperatorDeps
): Promise<RetryReport> {
  const ghsaId = ghsaIdOf(target)
  let runs: PatchRun[]
  let fromNeedsHuman: PatchRun | undefined
  if (target === ghsaId) {
    runs = await store.listRuns({ ghsaId })
  } else {
    const run = await store.getRun(target)
    if (!run) throw new Error(`no patch run ${target}`)
    runs = [run]
    if (run.state === 'needs-human' && !run.stable) {
      if (needsHumanStep(run, await store.listEvents(run.id))) fromNeedsHuman = run
      else if (!advisoryHeld(run)) throw new Error(cannotResume(run))
    }
  }
  const retried = (run: PatchRun) => resumable(run) || run === fromNeedsHuman
  runs = runs.filter((run) => retried(run) || advisoryHeld(run))

  const retriedJobs = await queue.retryFailedJobs(ghsaId)
  if (runs.some(advisoryHeld)) await queue.send({ type: 'advisory-published', ghsaId })
  for (const run of runs.filter(retried)) {
    await queue.send({
      type: 'retry-requested',
      runId: run.id,
      ...(run === fromNeedsHuman ? { fromNeedsHuman: true } : {})
    })
  }
  return { retriedJobs, retriedRuns: runs.map((run) => run.id) }
}

export async function injectTestAdvisory(
  raw: unknown,
  allowedPackages: readonly string[],
  { store, queue }: Pick<OperatorDeps, 'store'> & { queue: Pick<PipelineQueue, 'send'> }
): Promise<string> {
  const advisory = parseTestAdvisory(raw, allowedPackages)
  await store.saveTestAdvisory(advisory)
  await queue.send({ type: 'advisory-published', ghsaId: advisory.ghsaId })
  return advisory.ghsaId
}
