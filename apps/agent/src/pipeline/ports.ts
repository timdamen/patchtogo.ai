import type { LanguageModel } from 'ai'
import type { Advisory, SecurityAdvisory } from '../advisory.ts'
import type { Triage } from '../triage.ts'
import type { PatchRun, RunFailure, RunState } from './patch-run.ts'

export interface RepoRef {
  owner: string
  repo: string
}

export type FileChange = { path: string; content: string } | { path: string; delete: true }

export interface NewBranch {
  name: string
  parent: string
  message: string
  changes: FileChange[]
}

export interface GitHub {
  getAdvisory(ghsaId: string): Promise<SecurityAdvisory | undefined>
  getRepository(repo: RepoRef): Promise<RepoRef | undefined>
  findCommit(repo: RepoRef, ref: string): Promise<string | undefined>
  readFile(repo: RepoRef, ref: string, path: string): Promise<string | undefined>
  listFiles(repo: RepoRef, ref: string, directory: string): Promise<string[]>
  forkRepository(upstream: RepoRef, into: RepoRef): Promise<RepoRef>
  grantTeamAccess(repo: RepoRef, team: string): Promise<void>
  getBranch(repo: RepoRef, branch: string): Promise<string | undefined>
  createBranch(repo: RepoRef, branch: NewBranch): Promise<string>
  listBranches(repo: RepoRef): Promise<string[]>
  deleteBranch(repo: RepoRef, branch: string): Promise<void>
  setDefaultBranch(repo: RepoRef, branch: string): Promise<void>
  enableActions(repo: RepoRef): Promise<void>
}

export interface PublishedVersion {
  version: string
  repository: { url: string; directory: string | null } | null
  gitHead: string | null
  license: string | null
  tarball: { url: string; integrity: string | null }
  publishedAt: string | null
}

export interface PublishedPackage {
  name: string
  latest: string | null
  versions: PublishedVersion[]
}

export interface Registry {
  getPackage(name: string): Promise<PublishedPackage | undefined>
}

export interface PackageFiles {
  files: Record<string, string>
  packageJson: unknown
}

export interface BuildRequest {
  runId: string
  source: { repository: string; branch: string }
  directory: string
  tarball: PublishedVersion['tarball']
  publishedAt: string | null
}

export interface BuildResult {
  published: PackageFiles
  built: PackageFiles | null
  log: string
  sandboxSeconds: number
}

export interface Builder {
  build(request: BuildRequest): Promise<BuildResult>
}

export interface TestResult {
  passed: boolean
  output: string
}

export interface ModelSpend {
  usd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface FixSession {
  id: string
  transcript: string
  totals: ModelSpend
}

export interface FixCost extends ModelSpend {
  sandboxSeconds: number
}

export interface FixRequest {
  runId: string
  advisory: Advisory
  triage: Triage
  source: { repository: string; branch: string }
  instructions: string[]
  untrustedContext: string[]
  resume?: { session: FixSession; diff: string }
}

export interface FixResult {
  diff: string
  regressionBefore: TestResult
  regressionAfter: TestResult
  upstreamTests: TestResult
  summary: string
  cost: FixCost
  session: FixSession
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
  registry: Registry
  builder: Builder
  fixer: Fixer
  model: LanguageModel
  store: Store
  notifier: Notifier
  clock: Clock
}
