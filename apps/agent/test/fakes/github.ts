import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { SecurityAdvisory } from '../../src/advisory.ts'
import type { Author } from '../../src/pipeline/events.ts'
import type {
  BranchMove,
  BranchOf,
  DeploymentEnvironment,
  GitHub,
  MarkedComment,
  NewBranch,
  NewCommit,
  NewPullRequest,
  NewRepositoryAdvisory,
  PullRequest,
  RepoRef,
  RepositoryAdvisory,
  RepositoryAdvisoryUpdate,
  Review,
  ReviewComment,
  ReviewRule,
  ReviewState,
  UpstreamAccount
} from '../../src/pipeline/ports.ts'

export interface FakeCommit {
  sha: string
  parent: string | null
  message: string
  files: Record<string, string>
}

export interface FakeRepository {
  ref: RepoRef
  parent: RepoRef | null
  defaultBranch: string
  branches: Map<string, string>
  tags: Map<string, string>
  actionsEnabled: boolean
  teams: Map<string, string>
  environments: Map<string, string[]>
}

export interface NewRepository {
  files: Record<string, string>
  tags?: string[]
  branches?: string[]
  defaultBranch?: string
  message?: string
}

export interface FakePullRequest extends NewPullRequest, PullRequest {
  repo: string
  reviewTeams: string[]
  baseSha: string
  mergedHead: string | null
}

export interface FakeComment {
  repo: string
  pullRequest: number
  id: number
  author: Author
  body: string
}

export interface NewReview {
  author: string
  state: ReviewState
  body?: string
  comments?: { path: string; line?: number; body: string }[]
}

export interface FakeRepositoryAdvisory extends NewRepositoryAdvisory, RepositoryAdvisory {
  repo: string
}

export const BOT_LOGIN = 'patchtogo-bot[bot]'

export interface FakeRuleset {
  branchPrefix: string
  rule: ReviewRule
}

type Method = Exclude<keyof GitHub, 'getAdvisory'>

export const baseBranchRuleset: FakeRuleset = {
  branchPrefix: 'ptg/base/',
  rule: {
    approvals: 2,
    codeOwnerReview: true,
    lastPushApproval: true,
    bypass: 'never',
    teamReviews: [{ team: 'reviewers', approvals: 2, filePatterns: ['*'] }]
  }
}

function key({ owner, repo }: RepoRef): string {
  return `${owner}/${repo}`.toLowerCase()
}

function publicAdvisory(advisory: FakeRepositoryAdvisory): RepositoryAdvisory {
  const { ghsaId, url, state, description, vulnerabilities } = advisory
  return structuredClone({ ghsaId, url, state, description, vulnerabilities })
}

export class InMemoryGitHub implements GitHub {
  readonly advisories = new Map<string, SecurityAdvisory>()
  readonly repositories = new Map<string, FakeRepository>()
  readonly commits = new Map<string, FakeCommit>()
  readonly pullRequests: FakePullRequest[] = []
  readonly comments: FakeComment[] = []
  readonly repositoryAdvisories: FakeRepositoryAdvisory[] = []
  rulesets: FakeRuleset[] = [baseBranchRuleset]
  readonly calls: { method: Method; repo: string }[] = []
  readonly #teamMembers = new Set<string>()
  readonly #reviews = new Map<string, Review>()
  #nextId = 100
  readonly #failures = new Map<Method, Error>()

  publishAdvisory(advisory: SecurityAdvisory): void {
    this.advisories.set(advisory.ghsaId, structuredClone(advisory))
  }

  addRepository(ref: RepoRef, init: NewRepository): string {
    const sha = this.#commit(null, init.message ?? 'initial commit', init.files)
    const defaultBranch = init.defaultBranch ?? 'main'
    this.repositories.set(key(ref), {
      ref: { ...ref },
      parent: null,
      defaultBranch,
      branches: new Map([defaultBranch, ...(init.branches ?? [])].map((b) => [b, sha])),
      tags: new Map((init.tags ?? []).map((tag) => [tag, sha])),
      actionsEnabled: false,
      teams: new Map(),
      environments: new Map()
    })
    return sha
  }

  repository(ref: RepoRef): FakeRepository | undefined {
    return this.repositories.get(key(ref))
  }

  forks(): FakeRepository[] {
    return [...this.repositories.values()].filter((repository) => repository.parent)
  }

  fileAt(ref: RepoRef, branch: string, path: string): string | undefined {
    const sha = this.repository(ref)?.branches.get(branch)
    return sha ? this.commits.get(sha)?.files[path] : undefined
  }

  changedFiles(ref: RepoRef, base: string, head: string): Record<string, string | null> {
    const branches = this.repository(ref)?.branches
    const before = this.commits.get(branches?.get(base) ?? '')?.files ?? {}
    const after = this.commits.get(branches?.get(head) ?? '')?.files ?? {}
    const changed: Record<string, string | null> = {}
    for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[path] !== after[path]) changed[path] = after[path] ?? null
    }
    return changed
  }

  addTeamMember(org: string, team: string, login: string): void {
    this.#teamMembers.add(`${org}/${team}/${login}`)
  }

  submitReview(ref: RepoRef, pullRequest: number, review: NewReview): Review {
    const base = `https://github.com/${ref.owner}/${ref.repo}/pull/${pullRequest}`
    const id = this.#nextId++
    const comments: ReviewComment[] = (review.comments ?? []).map((comment) => {
      const commentId = this.#nextId++
      return {
        id: commentId,
        path: comment.path,
        line: comment.line ?? null,
        body: comment.body,
        url: `${base}#discussion_r${commentId}`
      }
    })
    const submitted: Review = {
      id,
      author: { login: review.author, bot: false },
      state: review.state,
      body: review.body ?? '',
      url: `${base}#pullrequestreview-${id}`,
      comments
    }
    this.#reviews.set(`${key(ref)}#${pullRequest}#${id}`, submitted)
    return structuredClone(submitted)
  }

  pushCommit(ref: RepoRef, branch: string, message: string, files: Record<string, string>): string {
    const repository = this.repository(ref)
    const parent = this.commits.get(repository?.branches.get(branch) ?? '')
    if (!repository || !parent) throw new Error(`no branch ${branch} in ${key(ref)}`)
    const sha = this.#commit(parent.sha, message, { ...parent.files, ...files })
    repository.branches.set(branch, sha)
    return sha
  }

  mergePullRequest(ref: RepoRef, number: number): string {
    const repository = this.repository(ref)
    const pr = this.pullRequests.find((p) => p.repo === key(ref) && p.number === number)
    const head = this.commits.get(repository?.branches.get(pr?.head ?? '') ?? '')
    if (!repository || !pr || !head) throw new Error(`no pull request ${number} to merge`)
    const sha = this.#commit(head.sha, `Merge pull request #${number}`, head.files)
    repository.branches.set(pr.base, sha)
    pr.mergedHead = head.sha
    return sha
  }

  failNext(method: Method, error = new Error(`${method} failed`)): void {
    this.#failures.set(method, error)
  }

  #commit(parent: string | null, message: string, files: Record<string, string>): string {
    const sha = createHash('sha1')
      .update(JSON.stringify([parent, message, files, this.commits.size]))
      .digest('hex')
    this.commits.set(sha, { sha, parent, message, files: structuredClone(files) })
    return sha
  }

  #apply(parentSha: string, changes: NewBranch['changes']): Record<string, string> {
    const parent = this.commits.get(parentSha)
    if (!parent) throw new Error(`no commit ${parentSha}`)
    const files = { ...parent.files }
    for (const change of changes) {
      if ('delete' in change) delete files[change.path]
      else files[change.path] = change.content
    }
    return files
  }

  #track(method: Method, repo: RepoRef): FakeRepository | undefined {
    this.calls.push({ method, repo: key(repo) })
    const failure = this.#failures.get(method)
    if (failure) {
      this.#failures.delete(method)
      throw failure
    }
    return this.repository(repo)
  }

  #resolve(repository: FakeRepository, ref: string): FakeCommit | undefined {
    const sha = repository.branches.get(ref) ?? repository.tags.get(ref) ?? ref
    return this.commits.get(sha)
  }

  #existing(repo: RepoRef, method: Method): FakeRepository {
    const repository = this.#track(method, repo)
    if (!repository) throw new Error(`${key(repo)} does not exist`)
    return repository
  }

  async getAdvisory(ghsaId: string): Promise<SecurityAdvisory | undefined> {
    const advisory = this.advisories.get(ghsaId)
    return advisory && structuredClone(advisory)
  }

  async getRepository(repo: RepoRef): Promise<RepoRef | undefined> {
    const repository = this.#track('getRepository', repo)
    return repository && { ...repository.ref }
  }

  async defaultBranch(repo: RepoRef): Promise<string | undefined> {
    return this.#track('defaultBranch', repo)?.defaultBranch
  }

  async findCommit(repo: RepoRef, ref: string): Promise<string | undefined> {
    const repository = this.#track('findCommit', repo)
    return repository && this.#resolve(repository, ref)?.sha
  }

  async readFile(repo: RepoRef, ref: string, path: string): Promise<string | undefined> {
    const repository = this.#track('readFile', repo)
    return repository && this.#resolve(repository, ref)?.files[path]
  }

  async listFiles(repo: RepoRef, ref: string, directory: string): Promise<string[]> {
    const repository = this.#track('listFiles', repo)
    const files = (repository && this.#resolve(repository, ref)?.files) ?? {}
    return Object.keys(files).filter((path) => posix.dirname(path) === (directory || '.'))
  }

  async forkRepository(upstream: RepoRef, into: RepoRef): Promise<RepoRef> {
    const source = this.#existing(upstream, 'forkRepository')
    const forks = [...this.repositories.values()].filter(
      (r) => r.ref.owner === into.owner && r.parent && key(r.parent) === key(source.ref)
    )
    const existing = forks[0]
    if (existing) return { ...existing.ref }
    if (this.repository(into)) throw new Error(`${key(into)} exists and is not a fork`)
    this.repositories.set(key(into), {
      ref: { ...into },
      parent: { ...source.ref },
      defaultBranch: source.defaultBranch,
      branches: new Map(source.branches),
      tags: new Map(source.tags),
      actionsEnabled: false,
      teams: new Map(),
      environments: new Map()
    })
    return { ...into }
  }

  async grantTeamAccess(repo: RepoRef, team: string): Promise<void> {
    this.#existing(repo, 'grantTeamAccess').teams.set(team, 'push')
  }

  async getBranch(repo: RepoRef, branch: string): Promise<string | undefined> {
    return this.#existing(repo, 'getBranch').branches.get(branch)
  }

  async createBranch(repo: RepoRef, branch: NewBranch): Promise<string> {
    const repository = this.#existing(repo, 'createBranch')
    const existing = repository.branches.get(branch.name)
    if (existing) return existing
    const sha = this.#commit(
      branch.parent,
      branch.message,
      this.#apply(branch.parent, branch.changes)
    )
    repository.branches.set(branch.name, sha)
    return sha
  }

  async updateBranch(repo: RepoRef, branch: NewBranch): Promise<string> {
    const repository = this.#existing(repo, 'updateBranch')
    if (this.rulesets.some((ruleset) => branch.name.startsWith(ruleset.branchPrefix))) {
      throw new Error(`a ruleset requires a pull request to change ${branch.name}`)
    }
    const head = repository.branches.get(branch.name)
    if (head !== branch.parent) {
      throw new Error(`${branch.name} is at ${head ?? 'nothing'}, not ${branch.parent}`)
    }
    const sha = this.#commit(head, branch.message, this.#apply(head, branch.changes))
    repository.branches.set(branch.name, sha)
    return sha
  }

  async listBranches(repo: RepoRef): Promise<string[]> {
    return [...this.#existing(repo, 'listBranches').branches.keys()]
  }

  async deleteBranch(repo: RepoRef, branch: string): Promise<void> {
    const repository = this.#existing(repo, 'deleteBranch')
    if (repository.defaultBranch === branch) throw new Error('cannot delete the default branch')
    repository.branches.delete(branch)
  }

  async setDefaultBranch(repo: RepoRef, branch: string): Promise<void> {
    const repository = this.#existing(repo, 'setDefaultBranch')
    if (!repository.branches.has(branch)) throw new Error(`no branch ${branch}`)
    repository.defaultBranch = branch
  }

  async enableActions(repo: RepoRef): Promise<void> {
    this.#existing(repo, 'enableActions').actionsEnabled = true
  }

  async ensureEnvironment(repo: RepoRef, environment: DeploymentEnvironment): Promise<void> {
    this.#existing(repo, 'ensureEnvironment').environments.set(environment.name, [
      ...environment.branches
    ])
  }

  async findPullRequest(repo: RepoRef, head: string): Promise<PullRequest | undefined> {
    this.#existing(repo, 'findPullRequest')
    const found = this.pullRequests.find((pr) => pr.repo === key(repo) && pr.head === head)
    return found && { number: found.number, url: found.url }
  }

  async findPullRequestFrom(repo: RepoRef, head: BranchOf): Promise<PullRequest | undefined> {
    this.#existing(repo, 'findPullRequestFrom')
    const found = this.pullRequests.find(
      (pr) => pr.repo === key(repo) && pr.head === `${head.owner}:${head.branch}`
    )
    return found && { number: found.number, url: found.url }
  }

  async pullRequestFiles(repo: RepoRef, pullRequest: number): Promise<string[]> {
    const repository = this.#existing(repo, 'pullRequestFiles')
    const pr = this.pullRequests.find((p) => p.repo === key(repo) && p.number === pullRequest)
    if (!pr) throw new Error(`no pull request ${pullRequest}`)
    const before = this.commits.get(pr.baseSha)?.files ?? {}
    const after = this.commits.get(pr.mergedHead ?? repository.branches.get(pr.head) ?? '')?.files
    return [...new Set([...Object.keys(before), ...Object.keys(after ?? {})])].filter(
      (path) => before[path] !== after?.[path]
    )
  }

  async openPullRequest(repo: RepoRef, pullRequest: NewPullRequest): Promise<PullRequest> {
    const repository = this.#existing(repo, 'openPullRequest')
    for (const branch of [pullRequest.head, pullRequest.base]) {
      if (!repository.branches.has(branch)) throw new Error(`no branch ${branch}`)
    }
    if (this.pullRequests.some((pr) => pr.repo === key(repo) && pr.head === pullRequest.head)) {
      throw new Error(`a pull request for ${pullRequest.head} already exists`)
    }
    return this.#addPullRequest(repository, pullRequest)
  }

  #addPullRequest(repository: FakeRepository, pullRequest: NewPullRequest): PullRequest {
    const number = this.pullRequests.filter((pr) => pr.repo === key(repository.ref)).length + 1
    const url = `https://github.com/${repository.ref.owner}/${repository.ref.repo}/pull/${number}`
    this.pullRequests.push({
      ...pullRequest,
      number,
      url,
      repo: key(repository.ref),
      reviewTeams: [],
      baseSha: repository.branches.get(pullRequest.base) ?? '',
      mergedHead: null
    })
    return { number, url }
  }

  upstreamAccount(): UpstreamAccount {
    return {
      openPullRequest: async (repo, pullRequest) => {
        const upstream = this.repository(repo)
        const [owner = '', branch = ''] = pullRequest.head.split(':')
        const fork = this.forks().find(
          (candidate) =>
            candidate.ref.owner === owner && candidate.parent && key(candidate.parent) === key(repo)
        )
        if (!upstream || !fork?.branches.has(branch) || !upstream.branches.has(pullRequest.base)) {
          throw new Error(`cannot open ${pullRequest.head} against ${key(repo)}`)
        }
        return this.#addPullRequest(upstream, pullRequest)
      }
    }
  }

  async isTeamMember(org: string, team: string, login: string): Promise<boolean> {
    this.#track('isTeamMember', { owner: org, repo: team })
    return this.#teamMembers.has(`${org}/${team}/${login}`)
  }

  async getReview(
    repo: RepoRef,
    pullRequest: number,
    reviewId: number
  ): Promise<Review | undefined> {
    this.#existing(repo, 'getReview')
    const review = this.#reviews.get(`${key(repo)}#${pullRequest}#${reviewId}`)
    return review && structuredClone(review)
  }

  async createCommit(repo: RepoRef, commit: NewCommit): Promise<string> {
    this.#existing(repo, 'createCommit')
    if (!this.commits.has(commit.parent)) throw new Error(`no commit ${commit.parent}`)
    return this.#commit(commit.parent, commit.message, this.#apply(commit.treeFrom, commit.changes))
  }

  async moveBranch(repo: RepoRef, branch: string, move: BranchMove): Promise<boolean> {
    const repository = this.#existing(repo, 'moveBranch')
    const head = repository.branches.get(branch)
    if (head === move.to) return true
    if (head !== move.from || this.commits.get(move.to)?.parent !== move.from) return false
    repository.branches.set(branch, move.to)
    return true
  }

  async commentOnPullRequest(
    repo: RepoRef,
    pullRequest: number,
    comment: MarkedComment
  ): Promise<void> {
    this.#existing(repo, 'commentOnPullRequest')
    const posted = this.comments.some(
      (existing) =>
        existing.repo === key(repo) &&
        existing.pullRequest === pullRequest &&
        existing.author.bot &&
        existing.body.includes(`<!-- ${comment.marker} -->`)
    )
    if (posted) return
    this.comments.push({
      repo: key(repo),
      pullRequest,
      id: this.#nextId++,
      author: { login: BOT_LOGIN, bot: true },
      body: comment.body
    })
  }

  async requestTeamReview(repo: RepoRef, pullRequest: number, team: string): Promise<void> {
    const repository = this.#existing(repo, 'requestTeamReview')
    const found = this.pullRequests.find((pr) => pr.repo === key(repo) && pr.number === pullRequest)
    if (!found) throw new Error(`no pull request ${pullRequest}`)
    if (!repository.teams.has(team)) throw new Error(`${team} cannot access ${key(repo)}`)
    if (!found.reviewTeams.includes(team)) found.reviewTeams.push(team)
  }

  async listRepositoryAdvisories(repo: RepoRef): Promise<RepositoryAdvisory[]> {
    this.#existing(repo, 'listRepositoryAdvisories')
    return this.repositoryAdvisories
      .filter((advisory) => advisory.repo === key(repo))
      .map(publicAdvisory)
  }

  async createRepositoryAdvisory(
    repo: RepoRef,
    advisory: NewRepositoryAdvisory
  ): Promise<RepositoryAdvisory> {
    const repository = this.#existing(repo, 'createRepositoryAdvisory')
    const ghsaId = `GHSA-ptg0-fork-${String(this.repositoryAdvisories.length + 1).padStart(4, '0')}`
    const created: FakeRepositoryAdvisory = {
      ...structuredClone(advisory),
      repo: key(repo),
      ghsaId,
      url: `https://github.com/${repository.ref.owner}/${repository.ref.repo}/security/advisories/${ghsaId}`,
      state: 'draft'
    }
    this.repositoryAdvisories.push(created)
    return publicAdvisory(created)
  }

  async updateRepositoryAdvisory(
    repo: RepoRef,
    ghsaId: string,
    update: RepositoryAdvisoryUpdate
  ): Promise<void> {
    this.#existing(repo, 'updateRepositoryAdvisory')
    const advisory = this.repositoryAdvisories.find(
      (existing) => existing.repo === key(repo) && existing.ghsaId === ghsaId
    )
    if (!advisory) throw new Error(`no repository advisory ${ghsaId} in ${key(repo)}`)
    if (update.vulnerabilities) advisory.vulnerabilities = structuredClone(update.vulnerabilities)
    if (update.state) advisory.state = update.state
  }

  async branchReviewRules(repo: RepoRef, branch: string): Promise<ReviewRule[]> {
    this.#existing(repo, 'branchReviewRules')
    return this.rulesets
      .filter((ruleset) => branch.startsWith(ruleset.branchPrefix))
      .map((ruleset) => structuredClone(ruleset.rule))
  }
}
