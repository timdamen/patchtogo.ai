import type { Advisory } from '../advisory.ts'
import type { Triage } from '../triage.ts'
import type { PullRequest, RepoRef, TestResult } from './ports.ts'

const runStates = [
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
  'needs-human': ['approved'],
  forking: ['verifying', 'needs-human'],
  verifying: ['fixing', 'needs-human'],
  fixing: ['fixing', 'in-review', 'needs-human'],
  'in-review': ['in-review', 'approved', 'needs-human'],
  approved: ['approved', 'released', 'needs-human'],
  released: ['released', 'upstreamed', 'superseded'],
  upstreamed: ['superseded'],
  superseded: [],
  failed: []
}

export function isTerminal(state: RunState): boolean {
  return state !== 'failed' && nextStates[state].length === 0
}

function canTransition(from: RunState, to: RunState): boolean {
  if (to === 'failed') return from !== 'failed' && !isTerminal(from)
  return nextStates[from].includes(to)
}

export interface UpstreamRelease {
  version: string
  repository: RepoRef
  directory: string
  commit: { sha: string; ref: string }
  tarball: { url: string; integrity: string | null }
  license: string | null
  publishedAt: string | null
}

export interface BaseBranch {
  name: string
  sha: string
}

export interface FixOutcome {
  sessionId: string
  diff: string
  regressionBefore: TestResult
  regressionAfter: TestResult
  upstreamTests: TestResult
  summary: string
}

export interface Feedback {
  key: string
  author: string
  url: string
  text: string
}

export type IterationVerdict = 'push' | 'unchanged' | 'rejected' | 'blocked'

export interface Iteration {
  number: number
  feedback: Feedback[]
  verdict: IterationVerdict
  reason: string | null
  fix: FixOutcome | null
  commit: string | null
  pushed: boolean
}

export interface ReviewLoop {
  seen: string[]
  instructions: Feedback[]
  context: Feedback[]
  iterations: number
  current: Iteration | null
  handOver: { by: string; url: string } | null
}

export interface WorkflowRun {
  id: number
  url: string
  conclusion: string
}

export interface StableRelease {
  commit: string
  workflow?: WorkflowRun
  version?: string
}

export interface UpstreamProposal {
  branch: BaseBranch | null
  base: string | null
  compareUrl: string | null
  blocked: string | null
  notified: boolean
  pullRequest: PullRequest | null
}

export interface Superseded {
  version: string
  command: string
}

export interface PatchedRelease {
  runId: string
  version: string
  commit: string
}

export interface RunDetails {
  triage: Triage | null
  release?: UpstreamRelease
  fork?: RepoRef
  baseBranch?: BaseBranch
  fix?: FixOutcome
  patchBranch?: BaseBranch
  pullRequest?: PullRequest
  review?: ReviewLoop
  stable?: StableRelease
  upstream?: UpstreamProposal
  superseded?: Superseded
  basedOn?: PatchedRelease
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

export type Step = (run: PatchRun) => Promise<Transition | undefined>

export class IllegalTransitionError extends Error {
  override name = 'IllegalTransitionError'
}

function runId(ghsaId: string, packageName: string): string {
  return `${ghsaId}:${packageName}`
}

export function ghsaIdOf(id: string): string {
  const separator = id.indexOf(':')
  return separator === -1 ? id : id.slice(0, separator)
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

export function annotate(run: PatchRun, details: Partial<RunDetails>, at: Date): PatchRun {
  return { ...run, ...details, version: run.version + 1, updatedAt: at }
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
