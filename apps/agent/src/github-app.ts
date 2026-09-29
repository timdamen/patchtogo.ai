import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { createAppAuth } from '@octokit/auth-app'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'
import { Octokit } from '@octokit/rest'
import type { GitHubAppEnv } from './env.ts'
import { parseGlobalAdvisory } from './github-advisories.ts'
import type { GitHub, PullRequest, RepoRef } from './pipeline/ports.ts'
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

export type GitHubAppAdapter = GitHub & { sourceArchive: SourceArchive }

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
      const { data: base } = await gh.rest.git.getCommit({ ...repo, commit_sha: parent })
      const { data: tree } = await gh.rest.git.createTree({
        ...repo,
        base_tree: base.tree.sha,
        tree: changes.map((change) =>
          'delete' in change
            ? { path: change.path, mode: '100644' as const, type: 'blob' as const, sha: null }
            : {
                path: change.path,
                mode: change.mode ?? ('100644' as const),
                type: 'blob' as const,
                content: change.content
              }
        )
      })
      const { data: commit } = await gh.rest.git.createCommit({
        ...repo,
        message,
        tree: tree.sha,
        parents: [parent]
      })
      try {
        await gh.rest.git.createRef({ ...repo, ref: `refs/heads/${name}`, sha: commit.sha })
        return commit.sha
      } catch (error) {
        const existing = statusOf(error) === 422 ? await branchSha(repo, name) : undefined
        if (existing) return existing
        throw error
      }
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

    findPullRequest: openPullRequestFrom,

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
