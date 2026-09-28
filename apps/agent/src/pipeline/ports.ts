import type { LanguageModel } from 'ai'
import type { Advisory, SecurityAdvisory } from '../advisory.ts'
import type { Triage } from '../triage.ts'
import type { PatchRun, RunFailure, RunState } from './patch-run.ts'

export interface GitHub {
  getAdvisory(ghsaId: string): Promise<SecurityAdvisory | undefined>
}

export interface TestResult {
  passed: boolean
  output: string
}

export interface FixRequest {
  runId: string
  advisory: Advisory
  triage: Triage
  source: { repository: string; branch: string }
  instructions: string[]
  untrustedContext: string[]
}

export interface FixResult {
  diff: string
  regressionBefore: TestResult
  regressionAfter: TestResult
  upstreamTests: TestResult
  summary: string
}

export interface Fixer {
  fix(request: FixRequest): Promise<FixResult>
}

export interface RunFilter {
  ghsaId?: string
  state?: RunState
}

export interface RunEvent {
  runId: string
  version: number
  state: RunState
  reason: string | null
  failure: RunFailure | null
  at: Date
}

export interface RunCost {
  runId: string
  step: RunState
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  sandboxSeconds: number
  at: Date
}

export interface Store {
  createRunIfAbsent(run: PatchRun): Promise<PatchRun>
  getRun(id: string): Promise<PatchRun | undefined>
  listRuns(filter?: RunFilter): Promise<PatchRun[]>
  saveRun(run: PatchRun): Promise<void>
  listEvents(runId: string): Promise<RunEvent[]>
  recordCost(cost: RunCost): Promise<void>
  listCosts(runId: string): Promise<RunCost[]>
}

export class StaleRunError extends Error {
  override name = 'StaleRunError'
}

export interface NeedsHumanNotification {
  type: 'needs-human'
  runId: string
  ghsaId: string
  packageName: string
  reason: string
}

export type Notification = NeedsHumanNotification

export interface Notifier {
  notify(notification: Notification): Promise<void>
}

export interface Clock {
  now(): Date
}

export interface Ports {
  github: GitHub
  fixer: Fixer
  model: LanguageModel
  store: Store
  notifier: Notifier
  clock: Clock
}
