import type { LanguageModel } from 'ai'
import type { Advisory, SecurityAdvisory } from '../advisory.ts'
import type { Triage } from '../triage.ts'
import type { Author } from './events.ts'
import type { PatchRun, RunFailure, RunState } from './patch-run.ts'

export interface RepoRef {
  owner: string
  repo: string
}

export type FileMode = '100644' | '100755'

export type FileChange =
  | { path: string; content: string; mode?: FileMode }
  | { path: string; delete: true }

export interface NewBranch {
  name: string
  parent: string
  message: string
  changes: FileChange[]
}

export interface PullRequest {
  number: number
  url: string
}

export interface NewPullRequest {
  head: string
  base: string
  title: string
  body: string
}

export interface NewCommit {
  parent: string
  treeFrom: string
  message: string
  changes: FileChange[]
}

export interface BranchMove {
  from: string
  to: string
}

export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending'

export interface ReviewComment {
  id: number
  path: string
  line: number | null
  body: string
  url: string
}

export interface Review {
  id: number
  author: Author
  state: ReviewState
  body: string
  url: string
  comments: ReviewComment[]
}

export interface MarkedComment {
  marker: string
  body: string
}

export interface BranchOf {
  owner: string
  branch: string
}

export interface TeamReview {
  team: string | null
  approvals: number
  filePatterns: string[]
}

export interface ReviewRule {
  approvals: number
  codeOwnerReview: boolean
  lastPushApproval: boolean
  bypass: string | null
  teamReviews: TeamReview[]
}

export interface DeploymentEnvironment {
  name: string
  branches: string[]
}

export interface AffectedVersions {
  packageName: string
  range: string
  patched: string | null
}

export type RepositoryAdvisoryState = 'draft' | 'published' | 'closed' | 'withdrawn' | 'triage'

export interface NewRepositoryAdvisory {
  summary: string
  description: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  vulnerabilities: AffectedVersions[]
}

export interface RepositoryAdvisory {
  ghsaId: string
  url: string
  state: RepositoryAdvisoryState
  description: string
  vulnerabilities: AffectedVersions[]
}

export interface RepositoryAdvisoryUpdate {
  vulnerabilities?: AffectedVersions[]
  state?: 'published'
}

export interface GitHub {
  getAdvisory(ghsaId: string): Promise<SecurityAdvisory | undefined>
  getRepository(repo: RepoRef): Promise<RepoRef | undefined>
  defaultBranch(repo: RepoRef): Promise<string | undefined>
  findCommit(repo: RepoRef, ref: string): Promise<string | undefined>
  readFile(repo: RepoRef, ref: string, path: string): Promise<string | undefined>
  listFiles(repo: RepoRef, ref: string, directory: string): Promise<string[]>
  forkRepository(upstream: RepoRef, into: RepoRef): Promise<RepoRef>
  grantTeamAccess(repo: RepoRef, team: string): Promise<void>
  getBranch(repo: RepoRef, branch: string): Promise<string | undefined>
  createBranch(repo: RepoRef, branch: NewBranch): Promise<string>
  updateBranch(repo: RepoRef, branch: NewBranch): Promise<string>
  listBranches(repo: RepoRef): Promise<string[]>
  deleteBranch(repo: RepoRef, branch: string): Promise<void>
  setDefaultBranch(repo: RepoRef, branch: string): Promise<void>
  enableActions(repo: RepoRef): Promise<void>
  ensureEnvironment(repo: RepoRef, environment: DeploymentEnvironment): Promise<void>
  findPullRequest(repo: RepoRef, head: string): Promise<PullRequest | undefined>
  findPullRequestFrom(repo: RepoRef, head: BranchOf): Promise<PullRequest | undefined>
  pullRequestFiles(repo: RepoRef, pullRequest: number): Promise<string[]>
  openPullRequest(repo: RepoRef, pullRequest: NewPullRequest): Promise<PullRequest>
  requestTeamReview(repo: RepoRef, pullRequest: number, team: string): Promise<void>
  isTeamMember(org: string, team: string, login: string): Promise<boolean>
  getReview(repo: RepoRef, pullRequest: number, reviewId: number): Promise<Review | undefined>
  createCommit(repo: RepoRef, commit: NewCommit): Promise<string>
  moveBranch(repo: RepoRef, branch: string, move: BranchMove): Promise<boolean>
  commentOnPullRequest(repo: RepoRef, pullRequest: number, comment: MarkedComment): Promise<void>
  branchReviewRules(repo: RepoRef, branch: string): Promise<ReviewRule[]>
  listRepositoryAdvisories(repo: RepoRef): Promise<RepositoryAdvisory[]>
  createRepositoryAdvisory(
    repo: RepoRef,
    advisory: NewRepositoryAdvisory
  ): Promise<RepositoryAdvisory>
  updateRepositoryAdvisory(
    repo: RepoRef,
    ghsaId: string,
    update: RepositoryAdvisoryUpdate
  ): Promise<void>
}

export interface UpstreamAccount {
  openPullRequest(repo: RepoRef, pullRequest: NewPullRequest): Promise<PullRequest>
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
  modelToken: string
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

export interface ModelGrant {
  token: string
  revoke(): Promise<void>
}

export interface ModelAccess {
  grant(runId: string): Promise<ModelGrant>
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
  saveSession(runId: string, session: FixSession): Promise<void>
  getSession(runId: string): Promise<FixSession | undefined>
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

export interface PatchPrOpenedNotification {
  type: 'patch-pr-opened'
  runId: string
  ghsaId: string
  packageName: string
  url: string
}

export interface UpstreamPrReadyNotification {
  type: 'upstream-pr-ready'
  runId: string
  ghsaId: string
  packageName: string
  compareUrl: string
}

export interface UpstreamPrOpenedNotification {
  type: 'upstream-pr-opened'
  runId: string
  ghsaId: string
  packageName: string
  url: string
}

export interface UpstreamPrBlockedNotification {
  type: 'upstream-pr-blocked'
  runId: string
  ghsaId: string
  packageName: string
  reason: string
}

export interface SupersededNotification {
  type: 'superseded'
  runId: string
  ghsaId: string
  packageName: string
  version: string
  command: string
}

export interface RepositoryAdvisoryNotification {
  type: 'repository-advisory'
  runId: string
  ghsaId: string
  packageName: string
  patchedPackage: string
  url: string
  patchedVersion: string | null
}

export type Notification =
  | NeedsHumanNotification
  | PatchPrOpenedNotification
  | UpstreamPrReadyNotification
  | UpstreamPrOpenedNotification
  | UpstreamPrBlockedNotification
  | SupersededNotification
  | RepositoryAdvisoryNotification

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
  modelAccess: ModelAccess
  model: LanguageModel
  store: Store
  notifier: Notifier
  clock: Clock
  upstreamAccount?: UpstreamAccount
}
