import { ghsaIdOf, type PatchRun } from './pipeline/patch-run.ts'
import type { Store } from './pipeline/ports.ts'
import type { PipelineQueue } from './queue.ts'

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
  blockedAdvisories: string[]
}

function resumable(run: PatchRun): boolean {
  return (
    run.state === 'failed' ||
    (run.state === 'triaged' && run.triage?.decision === 'patch') ||
    (run.state === 'fixing' && !run.pullRequest) ||
    (run.state === 'in-review' && (run.review?.instructions.length ?? 0) > 0) ||
    (run.state === 'needs-human' && run.stable !== undefined)
  )
}

export async function listFailures({ store, queue }: OperatorDeps): Promise<Failures> {
  return {
    runs: await store.listRuns({ state: 'failed' }),
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
    runs = (await store.listRuns({ ghsaId })).filter(resumable)
  } else {
    const run = await store.getRun(target)
    if (!run) throw new Error(`no patch run ${target}`)
    runs = resumable(run) ? [run] : []
  }

  const retriedJobs = await queue.retryFailedJobs(ghsaId)
  for (const run of runs) await queue.send({ type: 'retry-requested', runId: run.id })
  return { retriedJobs, retriedRuns: runs.map((run) => run.id) }
}
