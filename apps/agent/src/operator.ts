import { ghsaIdOf, type PatchRun } from './pipeline/patch-run.ts'
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

function resumable(run: PatchRun): boolean {
  return (
    run.state === 'failed' ||
    run.held !== undefined ||
    (run.state === 'triaged' && run.triage?.decision === 'patch') ||
    (run.state === 'fixing' && !run.pullRequest) ||
    (run.state === 'in-review' && (run.review?.instructions.length ?? 0) > 0) ||
    (run.state === 'needs-human' && run.stable !== undefined) ||
    run.state === 'released'
  )
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
  if (target === ghsaId) {
    runs = await store.listRuns({ ghsaId })
  } else {
    const run = await store.getRun(target)
    if (!run) throw new Error(`no patch run ${target}`)
    runs = [run]
  }
  runs = runs.filter((run) => resumable(run) || advisoryHeld(run))

  const retriedJobs = await queue.retryFailedJobs(ghsaId)
  if (runs.some(advisoryHeld)) await queue.send({ type: 'advisory-published', ghsaId })
  for (const run of runs.filter(resumable)) {
    await queue.send({ type: 'retry-requested', runId: run.id })
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
