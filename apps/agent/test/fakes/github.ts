import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { SecurityAdvisory } from '../../src/advisory.ts'
import type { GitHub, NewBranch, RepoRef } from '../../src/pipeline/ports.ts'

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
}

export interface NewRepository {
  files: Record<string, string>
  tags?: string[]
  branches?: string[]
  defaultBranch?: string
  message?: string
}

type Method = Exclude<keyof GitHub, 'getAdvisory'>

function key({ owner, repo }: RepoRef): string {
  return `${owner}/${repo}`.toLowerCase()
}

export class InMemoryGitHub implements GitHub {
  readonly advisories = new Map<string, SecurityAdvisory>()
  readonly repositories = new Map<string, FakeRepository>()
  readonly commits = new Map<string, FakeCommit>()
  readonly calls: { method: Method; repo: string }[] = []
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
      teams: new Map()
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
      teams: new Map()
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
    const parent = this.commits.get(branch.parent)
    if (!parent) throw new Error(`no commit ${branch.parent}`)
    const files = { ...parent.files }
    for (const change of branch.changes) {
      if ('delete' in change) delete files[change.path]
      else files[change.path] = change.content
    }
    const sha = this.#commit(parent.sha, branch.message, files)
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
}
