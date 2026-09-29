import { posix } from 'node:path'
import { baseBranchName, BRANCH_NAMESPACE, packageSlug } from '../naming.ts'
import {
  findReadme,
  scaffolding,
  WORKFLOWS_DIRECTORY,
  type Scaffolding,
  type ScaffoldingSettings
} from '../scaffolding.ts'
import { compareTarballs, describeMismatch } from '../tarball-match.ts'
import { githubRepository, releaseRefs, repoName } from '../upstream.ts'
import { parseVulnerableRange } from '../vulnerable-range.ts'
import type { PatchRun, Step, UpstreamRelease } from './patch-run.ts'
import type { Ports, PublishedVersion, RepoRef } from './ports.ts'

export interface ForkSettings extends ScaffoldingSettings {
  forkOrg: string
}

interface NeedsHuman {
  needsHuman: string
}

const LOG_TAIL = 1500

function packageDirectory(directory: string | null | undefined): string {
  const normalized = posix.normalize(directory ?? '.').replace(/^\.?\/+|\/+$/g, '')
  return normalized === '.' || normalized.startsWith('..') ? '' : normalized
}

function packageNameOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    const name = (parsed as { name?: unknown } | null)?.name
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}

function tail(log: string): string {
  return log.length > LOG_TAIL ? `...${log.slice(-LOG_TAIL)}` : log
}

export function forkingSteps(
  { github, registry, builder, store, clock }: Ports,
  settings: ForkSettings
): { forking: Step; verifying: Step } {
  async function releaseCommit(repository: RepoRef, published: PublishedVersion, name: string) {
    const refs = [
      ...(published.gitHead ? [published.gitHead] : []),
      ...releaseRefs(name, published.version)
    ]
    for (const ref of refs) {
      const sha = await github.findCommit(repository, ref)
      if (sha) return { commit: { sha, ref }, refs }
    }
    return { commit: undefined, refs }
  }

  async function locateRelease(run: PatchRun): Promise<UpstreamRelease | NeedsHuman> {
    const { packageName, advisory } = run
    const range = parseVulnerableRange(advisory.vulnerableRange)
    if (!range) {
      return { needsHuman: `The vulnerable range ${advisory.vulnerableRange} cannot be parsed.` }
    }
    const published = await registry.getPackage(packageName)
    if (!published) return { needsHuman: `npm has no package ${packageName}.` }
    const version = range.latest(published.versions.map((v) => v.version))
    const release = published.versions.find((v) => v.version === version)
    if (!version || !release) {
      return {
        needsHuman: `No published version of ${packageName} is in the vulnerable range ${advisory.vulnerableRange}.`
      }
    }
    const label = `${packageName}@${version}`
    const url = release.repository?.url
    if (!url) return { needsHuman: `${label} names no source repository.` }
    const named = githubRepository(url)
    if (!named) return { needsHuman: `${label} names a repository outside GitHub: ${url}` }
    const repository = await github.getRepository(named)
    if (!repository) {
      return {
        needsHuman: `The repository of ${label}, ${repoName(named)}, does not exist or is not public.`
      }
    }
    const { commit, refs } = await releaseCommit(repository, release, packageName)
    if (!commit) {
      return {
        needsHuman: `${repoName(repository)} has no commit or tag for ${label} (tried ${refs.join(', ')}).`
      }
    }
    const directory = packageDirectory(release.repository?.directory)
    const where = `${repoName(repository)} at ${commit.ref}${directory ? `, in ${directory}/` : ''}`
    const manifest = await github.readFile(
      repository,
      commit.sha,
      posix.join(directory || '.', 'package.json')
    )
    const upstreamName = packageNameOf(manifest)
    if (upstreamName !== packageName) {
      return {
        needsHuman: upstreamName
          ? `${where} holds the package ${upstreamName}, not ${packageName}.`
          : `${where} has no readable package.json for ${packageName}.`
      }
    }
    return {
      version,
      repository,
      directory,
      commit,
      tarball: release.tarball,
      license: release.license,
      publishedAt: release.publishedAt
    }
  }

  async function tarballMismatch(run: PatchRun, release: UpstreamRelease, fork: RepoRef) {
    const result = await builder.build({
      runId: run.id,
      source: { repository: repoName(fork), branch: release.commit.sha },
      directory: release.directory,
      tarball: release.tarball,
      publishedAt: release.publishedAt
    })
    await store.recordCost({
      runId: run.id,
      step: run.state,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      sandboxSeconds: result.sandboxSeconds,
      at: clock.now()
    })
    const built = `${run.packageName}@${release.version} built from ${repoName(fork)} at ${release.commit.ref}`
    if (!result.built) return `${built} failed to build:\n${tail(result.log)}`
    const comparison = compareTarballs(result.published, result.built)
    if (comparison.matches) return undefined
    return `${built} does not match the npm tarball: ${describeMismatch(comparison)}.`
  }

  async function scaffold(run: PatchRun, release: UpstreamRelease, fork: RepoRef) {
    const { sha } = release.commit
    const at = (file: string) => posix.join(release.directory || '.', file)
    const packageJson = await github.readFile(fork, sha, at('package.json'))
    if (packageJson === undefined) throw new Error(`${repoName(fork)} has no ${at('package.json')}`)
    const directoryFiles = await github.listFiles(fork, sha, release.directory)
    const readmePath = findReadme(directoryFiles)
    const readmeText = readmePath ? await github.readFile(fork, sha, readmePath) : undefined
    return scaffolding({
      packageName: run.packageName,
      release,
      fork,
      packageJson,
      directoryFiles,
      readme:
        readmePath && readmeText !== undefined ? { path: readmePath, text: readmeText } : null,
      workflowFiles: await github.listFiles(fork, sha, WORKFLOWS_DIRECTORY),
      settings
    }) satisfies Scaffolding
  }

  async function isolate(fork: RepoRef, baseBranch: string) {
    await github.setDefaultBranch(fork, baseBranch)
    for (const branch of await github.listBranches(fork)) {
      if (!branch.startsWith(BRANCH_NAMESPACE)) await github.deleteBranch(fork, branch)
    }
    await github.enableActions(fork)
  }

  return {
    async forking(run) {
      const release = await locateRelease(run)
      if ('needsHuman' in release) return { to: 'needs-human', reason: release.needsHuman }
      const fork = await github.forkRepository(release.repository, {
        owner: settings.forkOrg,
        repo: packageSlug(run.packageName)
      })
      await github.grantTeamAccess(fork, settings.reviewerTeam)
      return {
        to: 'verifying',
        reason: `Forked ${repoName(release.repository)} to ${repoName(fork)}; ${run.packageName}@${release.version} is ${release.commit.ref}.`,
        details: { release, fork }
      }
    },

    async verifying(run) {
      const { release, fork } = run
      if (!release || !fork) throw new Error(`patch run ${run.id} has no fork to verify`)
      const name = baseBranchName(run.packageName, release.version)
      let sha = await github.getBranch(fork, name)
      if (!sha) {
        const mismatch = await tarballMismatch(run, release, fork)
        if (mismatch) return { to: 'needs-human', reason: mismatch }
        const { message, changes } = await scaffold(run, release, fork)
        sha = await github.createBranch(fork, {
          name,
          parent: release.commit.sha,
          message,
          changes
        })
      }
      await isolate(fork, name)
      return {
        to: 'fixing',
        reason: `The fork matches the npm tarball; base branch ${name} is ready in ${repoName(fork)}.`,
        details: { baseBranch: { name, sha } }
      }
    }
  }
}
