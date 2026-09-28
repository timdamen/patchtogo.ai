import type { Advisory } from '../advisory.ts'
import type { Triage } from '../triage.ts'

export const runStates = [
  'detected',
  'triaged',
  'skipped',
  'needs-human',
  'forking',
  'verifying',
  'fixing',
  'in-review',
  'approved',
  'released',
  'upstreamed',
  'superseded',
  'failed'
] as const

export type RunState = (typeof runStates)[number]

const nextStates: Record<RunState, readonly RunState[]> = {
  detected: ['triaged'],
  triaged: ['skipped', 'needs-human', 'forking'],
  skipped: [],
  'needs-human': [],
  forking: ['verifying'],
  verifying: ['fixing', 'needs-human'],
  fixing: ['in-review', 'needs-human'],
  'in-review': ['in-review', 'approved', 'needs-human'],
  approved: ['released'],
  released: ['upstreamed', 'superseded'],
  upstreamed: ['superseded'],
  superseded: [],
  failed: []
}

export function isTerminal(state: RunState): boolean {
  return state !== 'failed' && nextStates[state].length === 0
}

export function canTransition(from: RunState, to: RunState): boolean {
  if (to === 'failed') return from !== 'failed' && !isTerminal(from)
  return nextStates[from].includes(to)
}

export interface RunDetails {
  triage: Triage | null
}

export interface RunFailure {
  step: RunState
  error: string
}

export interface PatchRun extends RunDetails {
  id: string
  ghsaId: string
  packageName: string
  advisory: Advisory
  state: RunState
  reason: string | null
  failure: RunFailure | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface Transition {
  to: RunState
  reason?: string
  details?: Partial<RunDetails>
}

export class IllegalTransitionError extends Error {
  override name = 'IllegalTransitionError'
}

export function runId(ghsaId: string, packageName: string): string {
  return `${ghsaId}:${packageName}`
}

export function newPatchRun(advisory: Advisory, at: Date): PatchRun {
  return {
    id: runId(advisory.ghsaId, advisory.packageName),
    ghsaId: advisory.ghsaId,
    packageName: advisory.packageName,
    advisory,
    state: 'detected',
    reason: null,
    failure: null,
    triage: null,
    version: 0,
    createdAt: at,
    updatedAt: at
  }
}

export function transition(run: PatchRun, next: Transition, at: Date): PatchRun {
  if (!canTransition(run.state, next.to)) {
    throw new IllegalTransitionError(
      `patch run ${run.id} cannot move from ${run.state} to ${next.to}`
    )
  }
  const reason = next.reason ?? null
  return {
    ...run,
    ...next.details,
    state: next.to,
    reason,
    failure: next.to === 'failed' ? { step: run.state, error: reason ?? 'unknown error' } : null,
    version: run.version + 1,
    updatedAt: at
  }
}

export function retry(run: PatchRun, at: Date): PatchRun {
  if (run.state !== 'failed' || !run.failure) {
    throw new IllegalTransitionError(`patch run ${run.id} is ${run.state}, so it cannot be retried`)
  }
  return {
    ...run,
    state: run.failure.step,
    reason: `retrying after: ${run.failure.error}`,
    failure: null,
    version: run.version + 1,
    updatedAt: at
  }
}
