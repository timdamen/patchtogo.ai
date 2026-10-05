import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { createAppAuth } from '@octokit/auth-app'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'
import { Octokit } from '@octokit/rest'
import type { GitHubAppEnv } from './env.ts'
import { parseGlobalAdvisory } from './github-advisories.ts'
import type { Author } from './pipeline/events.ts'
import type {
  AffectedVersions,
  FileChange,
  GitHub,
  NewCommit,
  PullRequest,
  RepoRef,
  RepositoryAdvisory,
  ReviewRule,
  ReviewState,
  UpstreamAccount
} from './pipeline/ports.ts'
import type { SourceArchive } from './sandbox.ts'
import { repoName } from './upstream.ts'

const AppOctokit = Octokit.plugin(retry, throttling)

const log = {
  debug: () => {},
  info: () => {},
  warn: console.warn,
  error: () => {}
}

const throttle = {
  onRateLimit: (_after: number, _options: object, _octokit: unknown, retries: number) =>
    retries < 2,
  onSecondaryRateLimit: (_after: number, _options: object, _octokit: unknown, retries: number) =>
    retries < 2
}

export async function installationOctokit(env: GitHubAppEnv, org: string): Promise<Octokit> {
  const privateKey =
    env.GITHUB_APP_PRIVATE_KEY?.replaceAll('\\n', '\n') ??
    (await readFile(env.GITHUB_APP_PRIVATE_KEY_PATH ?? '', 'utf8'))
  const auth = { appId: env.GITHUB_APP_ID, privateKey }
  let installationId = env.GITHUB_APP_INSTALLATION_ID
  if (installationId === undefined) {
    const app = new AppOctokit({ authStrategy: createAppAuth, auth, throttle, log })
    installationId = (await app.rest.apps.getOrgInstallation({ org })).data.id
  }
  return new AppOctokit({
    authStrategy: createAppAuth,
    auth: { ...auth, installationId },
    throttle,
    log
  })
}

export function tokenOctokit(token: string): Octokit {
  return new AppOctokit({ auth: token, throttle, log })
}

export function createUpstreamAccount(gh: Octokit): UpstreamAccount {
  return {
    async openPullRequest(repo, { head, base, title, body }) {
      const { data } = await gh.rest.pulls.create({ ...repo, head, base, title, body })
      return { number: data.number, url: data.html_url }
    }
  }
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number(error.status)
    : undefined
}

async function unlessStatus<T>(statuses: number[], request: Promise<T>): Promise<T | undefined> {
  try {
    return await request
  } catch (error) {
    if (statuses.includes(statusOf(error) ?? 0)) return undefined
    throw error
  }
}

interface RepositoryData {
  name: string
  owner: { login: string }
  fork: boolean
  default_branch: string
  parent?: { full_name: string }
  source?: { full_name: string }
}

interface TeamReviewParameters {
  required_reviewers?: {
    reviewer: { id: number; type: string }
    minimum_approvals: number
    file_patterns: string[]
  }[]
}

function refOf(data: RepositoryData): RepoRef {
  return { owner: data.owner.login, repo: data.name }
}

function isForkOf(data: RepositoryData, upstream: RepoRef): boolean {
  const wanted = repoName(upstream).toLowerCase()
  return (
    data.fork &&
    [data.parent?.full_name, data.source?.full_name].some((name) => name?.toLowerCase() === wanted)
  )
}

export interface GitHubAppOptions {
  forkReadyTimeoutMs?: number
  pollIntervalMs?: number
}

export interface PullRequestHeads {
  pullRequestHead(repo: RepoRef, pullRequest: number): Promise<string | undefined>
}

export type GitHubAppAdapter = GitHub & PullRequestHeads & { sourceArchive: SourceArchive }

const reviewStates: Record<string, ReviewState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending'
}

interface RepositoryAdvisoryData {
  ghsa_id: string
  html_url: string
  state: RepositoryAdvisory['state']
  description: string | null
  vulnerabilities:
    | {
        package: { ecosystem: string; name: string | null } | null
        vulnerable_version_range: string | null
        patched_versions: string | null
      }[]
    | null
}

function repositoryAdvisoryOf(data: RepositoryAdvisoryData): RepositoryAdvisory {
  return {
    ghsaId: data.ghsa_id,
    url: data.html_url,
    state: data.state,
    description: data.description ?? '',
    vulnerabilities: (data.vulnerabilities ?? []).map((vulnerability) => ({
      packageName: vulnerability.package?.name ?? '',
      range: vulnerability.vulnerable_version_range ?? '',
      patched: vulnerability.patched_versions || null
    }))
  }
}

function npmVulnerabilities(vulnerabilities: AffectedVersions[]) {
  return vulnerabilities.map(({ packageName, range, patched }) => ({
    package: { ecosystem: 'npm' as const, name: packageName },
    vulnerable_version_range: range,
    patched_versions: patched
  }))
}

export function authorOf(user: { login: string; type?: string } | null | undefined): Author {
  return { login: user?.login ?? 'ghost', bot: user?.type !== 'User' }
}

function treeEntries(changes: FileChange[]) {
  return changes.map((change) =>
    'delete' in change
      ? { path: change.path, mode: '100644' as const, type: 'blob' as const, sha: null }
      : {
          path: change.path,
          mode: change.mode ?? ('100644' as const),
          type: 'blob' as const,
          content: change.content
        }
  )
}

export function createGitHubApp(gh: Octokit, options: GitHubAppOptions = {}): GitHubAppAdapter {
  const readyTimeoutMs = options.forkReadyTimeoutMs ?? 5 * 60_000
  const pollIntervalMs = options.pollIntervalMs ?? 3000

  async function commitSha(repo: RepoRef, ref: string): Promise<string | undefined> {
    const response = await unlessStatus(
      [404, 409, 422],
      gh.request('GET /repos/{owner}/{repo}/commits/{ref}', {
        ...repo,
        ref,
        headers: { accept: 'application/vnd.github.sha' }
      })
    )
    const sha = response && String(response.data as unknown).trim()
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
  }

  async function branchSha(repo: RepoRef, branch: string): Promise<string | undefined> {
    const response = await unlessStatus(
      [404],
      gh.rest.git.getRef({ ...repo, ref: `heads/${branch}` })
    )
    return response?.data.object.sha
  }

  async function openPullRequestFrom(
    repo: RepoRef,
    head: string
  ): Promise<PullRequest | undefined> {
    const { data } = await gh.rest.pulls.list({
      ...repo,
      head: `${repo.owner}:${head}`,
      state: 'open',
      per_page: 1
    })
    const [found] = data
    return found && { number: found.number, url: found.html_url }
  }

  async function commit(
    repo: RepoRef,
    { parent, treeFrom, message, changes }: NewCommit
  ): Promise<string> {
    const { data: base } = await gh.rest.git.getCommit({ ...repo, commit_sha: treeFrom })
    const { data: tree } = await gh.rest.git.createTree({
      ...repo,
      base_tree: base.tree.sha,
      tree: treeEntries(changes)
    })
    const { data } = await gh.rest.git.createCommit({
      ...repo,
      message,
      tree: tree.sha,
      parents: [parent]
    })
    return data.sha
  }

  async function waitUntilReady(fork: RepoRef, branch: string): Promise<void> {
    const deadline = Date.now() + readyTimeoutMs
    while (!(await commitSha(fork, branch))) {
      if (Date.now() > deadline) {
        throw new Error(`the fork ${repoName(fork)} was not ready after ${readyTimeoutMs} ms`)
      }
      await sleep(pollIntervalMs)
    }
  }

  return {
    async getAdvisory(ghsaId) {
      const response = await unlessStatus(
        [404],
        gh.rest.securityAdvisories.getGlobalAdvisory({ ghsa_id: ghsaId })
      )
      return response && parseGlobalAdvisory(response.data)
    },

    async getRepository(repo) {
      const response = await unlessStatus([404, 451], gh.rest.repos.get({ ...repo }))
      return response && refOf(response.data)
    },

    async defaultBranch(repo) {
      const response = await unlessStatus([404, 451], gh.rest.repos.get({ ...repo }))
      return response?.data.default_branch
    },

    findCommit: commitSha,

    async readFile(repo, ref, path) {
      const response = await unlessStatus(
        [404],
        gh.rest.repos.getContent({ ...repo, path, ref, mediaType: { format: 'raw' } })
      )
      return response === undefined ? undefined : String(response.data as unknown)
    },

    async listFiles(repo, ref, directory) {
      const response = await unlessStatus(
        [404],
        gh.rest.repos.getContent({ ...repo, path: directory, ref })
      )
      const entries = response?.data
      if (!Array.isArray(entries)) return []
      return entries.filter((entry) => entry.type === 'file').map((entry) => entry.path)
    },

    async forkRepository(upstream, into) {
      const existing = await unlessStatus([404], gh.rest.repos.get({ ...into }))
      let fork: RepositoryData
      if (existing) {
        fork = existing.data
      } else {
        const created = await gh.rest.repos.createFork({
          ...upstream,
          organization: into.owner,
          name: into.repo,
          default_branch_only: false
        })
        fork = created.data
      }
      if (!isForkOf(fork, upstream)) {
        throw new Error(
          `${repoName(refOf(fork))} exists and is not a fork of ${repoName(upstream)}`
        )
      }
      await waitUntilReady(refOf(fork), fork.default_branch)
      return refOf(fork)
    },

    async grantTeamAccess(repo, team) {
      await gh.rest.teams.addOrUpdateRepoPermissionsInOrg({
        org: repo.owner,
        team_slug: team,
        ...repo,
        permission: 'push'
      })
    },

    getBranch: branchSha,

    async createBranch(repo, { name, parent, message, changes }) {
      const sha = await commit(repo, { parent, treeFrom: parent, message, changes })
      try {
        await gh.rest.git.createRef({ ...repo, ref: `refs/heads/${name}`, sha })
        return sha
      } catch (error) {
        const existing = statusOf(error) === 422 ? await branchSha(repo, name) : undefined
        if (existing) return existing
        throw error
      }
    },

    async updateBranch(repo, { name, parent, message, changes }) {
      const sha = await commit(repo, { parent, treeFrom: parent, message, changes })
      await gh.rest.git.updateRef({ ...repo, ref: `heads/${name}`, sha, force: false })
      return sha
    },

    async listBranches(repo) {
      const branches = await gh.paginate(gh.rest.repos.listBranches, { ...repo, per_page: 100 })
      return branches.map((branch) => branch.name)
    },

    async deleteBranch(repo, branch) {
      await unlessStatus([404, 422], gh.rest.git.deleteRef({ ...repo, ref: `heads/${branch}` }))
    },

    async setDefaultBranch(repo, branch) {
      await gh.rest.repos.update({ ...repo, default_branch: branch })
    },

    async enableActions(repo) {
      await gh.rest.actions.setGithubActionsPermissionsRepository({ ...repo, enabled: true })
    },

    async ensureEnvironment(repo, { name, branches }) {
      const environment = { ...repo, environment_name: name }
      await gh.rest.repos.createOrUpdateEnvironment({
        ...environment,
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
      })
      const { data } = await gh.rest.repos.listDeploymentBranchPolicies({
        ...environment,
        per_page: 100
      })
      const kept = new Set<string>()
      for (const policy of data.branch_policies) {
        if (policy.type === 'branch' && policy.name && branches.includes(policy.name)) {
          kept.add(policy.name)
        } else if (policy.id !== undefined) {
          await gh.rest.repos.deleteDeploymentBranchPolicy({
            ...environment,
            branch_policy_id: policy.id
          })
        }
      }
      for (const branch of branches.filter((pattern) => !kept.has(pattern))) {
        await gh.rest.repos.createDeploymentBranchPolicy({
          ...environment,
          name: branch,
          type: 'branch'
        })
      }
    },

    findPullRequest: openPullRequestFrom,

    async findPullRequestFrom(repo, { owner, branch }) {
      const { data } = await gh.rest.pulls.list({
        ...repo,
        head: `${owner}:${branch}`,
        state: 'all',
        per_page: 1
      })
      const [found] = data
      return found && { number: found.number, url: found.html_url }
    },

    async pullRequestFiles(repo, pullRequest) {
      const files = await gh.paginate(gh.rest.pulls.listFiles, {
        ...repo,
        pull_number: pullRequest,
        per_page: 100
      })
      return files.flatMap((file) =>
        file.previous_filename ? [file.previous_filename, file.filename] : [file.filename]
      )
    },

    async openPullRequest(repo, { head, base, title, body }) {
      try {
        const { data } = await gh.rest.pulls.create({ ...repo, head, base, title, body })
        return { number: data.number, url: data.html_url }
      } catch (error) {
        const existing = statusOf(error) === 422 ? await openPullRequestFrom(repo, head) : undefined
        if (existing) return existing
        throw error
      }
    },

    async requestTeamReview(repo, pullRequest, team) {
      await gh.rest.pulls.requestReviewers({
        ...repo,
        pull_number: pullRequest,
        team_reviewers: [team]
      })
    },

    async isTeamMember(org, team, login) {
      const response = await unlessStatus(
        [404],
        gh.rest.teams.getMembershipForUserInOrg({ org, team_slug: team, username: login })
      )
      return response?.data.state === 'active'
    },

    async getReview(repo, pullRequest, reviewId) {
      const response = await unlessStatus(
        [404],
        gh.rest.pulls.getReview({ ...repo, pull_number: pullRequest, review_id: reviewId })
      )
      if (!response) return undefined
      const { data } = response
      const comments = await gh.paginate(gh.rest.pulls.listCommentsForReview, {
        ...repo,
        pull_number: pullRequest,
        review_id: reviewId,
        per_page: 100
      })
      return {
        id: data.id,
        author: authorOf(data.user),
        state: reviewStates[data.state] ?? 'pending',
        body: data.body ?? '',
        url: data.html_url,
        comments: comments.map((comment) => ({
          id: comment.id,
          path: comment.path,
          line: comment.line ?? comment.original_line ?? null,
          body: comment.body,
          url: comment.html_url
        }))
      }
    },

    createCommit: commit,

    async moveBranch(repo, branch, { from, to }) {
      const head = await branchSha(repo, branch)
      if (head === to) return true
      if (head !== from) return false
      try {
        await gh.rest.git.updateRef({ ...repo, ref: `heads/${branch}`, sha: to, force: false })
        return true
      } catch (error) {
        if (statusOf(error) !== 422) throw error
        return (await branchSha(repo, branch)) === to
      }
    },

    async commentOnPullRequest(repo, pullRequest, { marker, body }) {
      const existing = await gh.paginate(gh.rest.issues.listComments, {
        ...repo,
        issue_number: pullRequest,
        per_page: 100
      })
      const tag = `<!-- ${marker} -->`
      const posted = existing.some(
        (comment) => comment.user?.type === 'Bot' && comment.body?.includes(tag)
      )
      if (!posted) await gh.rest.issues.createComment({ ...repo, issue_number: pullRequest, body })
    },

    async pullRequestHead(repo, pullRequest) {
      const response = await unlessStatus(
        [404],
        gh.rest.pulls.get({ ...repo, pull_number: pullRequest })
      )
      return response?.data.head.ref
    },

    async branchReviewRules(repo, branch) {
      const rules = await gh.paginate(gh.rest.repos.getBranchRules, {
        ...repo,
        branch,
        per_page: 100
      })
      const reviews = rules.flatMap((rule) =>
        rule.type === 'pull_request'
          ? [
              {
                ...rule.parameters,
                teamReviewers:
                  (rule.parameters as TeamReviewParameters | undefined)?.required_reviewers ?? [],
                rulesetId: rule.ruleset_id
              }
            ]
          : []
      )
      const bypass = new Map<number, string | null>()
      for (const id of new Set(reviews.map((review) => review.rulesetId))) {
        if (id === undefined) continue
        const ruleset = await unlessStatus(
          [404],
          gh.rest.repos.getRepoRuleset({ ...repo, ruleset_id: id, includes_parents: true })
        )
        bypass.set(id, ruleset?.data.current_user_can_bypass ?? null)
      }
      const teams = new Map<number, string>()
      if (reviews.some((review) => review.teamReviewers.length > 0)) {
        const listed = await gh.paginate(gh.rest.teams.list, { org: repo.owner, per_page: 100 })
        for (const team of listed) teams.set(team.id, team.slug)
      }
      return reviews.map((review): ReviewRule => ({
        approvals: review.required_approving_review_count ?? 0,
        codeOwnerReview: review.require_code_owner_review ?? false,
        lastPushApproval: review.require_last_push_approval ?? false,
        bypass: (review.rulesetId !== undefined && bypass.get(review.rulesetId)) || null,
        teamReviews: review.teamReviewers.map((required) => ({
          team: teams.get(required.reviewer.id) ?? null,
          approvals: required.minimum_approvals,
          filePatterns: required.file_patterns
        }))
      }))
    },

    async listRepositoryAdvisories(repo) {
      const advisories = await gh.paginate(gh.rest.securityAdvisories.listRepositoryAdvisories, {
        ...repo,
        per_page: 100
      })
      return advisories.map(repositoryAdvisoryOf)
    },

    async createRepositoryAdvisory(repo, { summary, description, severity, vulnerabilities }) {
      const { data } = await gh.rest.securityAdvisories.createRepositoryAdvisory({
        ...repo,
        summary,
        description,
        severity,
        vulnerabilities: npmVulnerabilities(vulnerabilities)
      })
      return repositoryAdvisoryOf(data)
    },

    async updateRepositoryAdvisory(repo, ghsaId, { vulnerabilities, state }) {
      await gh.rest.securityAdvisories.updateRepositoryAdvisory({
        ...repo,
        ghsa_id: ghsaId,
        ...(vulnerabilities ? { vulnerabilities: npmVulnerabilities(vulnerabilities) } : {}),
        ...(state ? { state } : {})
      })
    },

    async sourceArchive(source) {
      const [owner = '', repo = ''] = source.repository.split('/')
      const response = await gh.rest.repos.downloadTarballArchive({
        owner,
        repo,
        ref: source.branch
      })
      return new Uint8Array(response.data as ArrayBuffer)
    }
  }
}
