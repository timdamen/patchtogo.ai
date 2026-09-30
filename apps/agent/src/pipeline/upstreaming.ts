import { patchedPackageName, upstreamBranchName, type NamingSettings } from '../naming.ts'
import { isTestAdvisory } from '../test-advisories.ts'
import { DiffError, diffChanges } from '../unified-diff.ts'
import { repoName } from '../upstream.ts'
import {
  compareUrl,
  upstreamCommitMessage,
  upstreamPrBody,
  upstreamPrTitle,
  type UpstreamPrInput
} from '../upstream-pr.ts'
import type { PatchRun, Step, Transition, UpstreamProposal } from './patch-run.ts'
import type { FileChange, Ports, PullRequest } from './ports.ts'

const pending: UpstreamProposal = {
  branch: null,
  base: null,
  compareUrl: null,
  blocked: null,
  notified: false,
  pullRequest: null
}

function released(run: PatchRun, settings: NamingSettings) {
  const { release, fork, fix, stable, pullRequest, patchBranch } = run
  if (!release || !fork || !fix || !stable?.version || !pullRequest || !patchBranch) {
    throw new Error(`patch run ${run.id} has no released fix to propose upstream`)
  }
  const input: UpstreamPrInput = {
    run,
    release,
    fix,
    patchPullRequest: pullRequest,
    published: `${patchedPackageName(run.packageName, settings)}@${stable.version}`
  }
  return { release, fork, fix, stable, pullRequest, patchBranch, input }
}

function blocked(reason: string): Transition {
  return { to: 'released', reason, details: { upstream: { ...pending, blocked: reason } } }
}

function upstreamed(upstream: UpstreamProposal, pullRequest: PullRequest): Transition {
  return {
    to: 'upstreamed',
    reason: `The fix is proposed upstream in ${pullRequest.url}.`,
    details: { upstream: { ...upstream, pullRequest } }
  }
}

export function upstreamingSteps(ports: Ports, settings: NamingSettings): { released: Step } {
  const { github, notifier, upstreamAccount } = ports

  async function differences(run: PatchRun, changes: FileChange[]): Promise<string[] | undefined> {
    const { fork, stable, pullRequest, patchBranch } = released(run, settings)
    const fixed = new Set(changes.map((change) => change.path))
    const merged = new Set(await github.pullRequestFiles(fork, pullRequest.number))
    const differing = [...new Set([...fixed, ...merged])].filter(
      (path) => !fixed.has(path) || !merged.has(path)
    )
    for (const change of changes) {
      if ('delete' in change || differing.includes(change.path)) continue
      const [atMerge, atFix] = await Promise.all([
        github.readFile(fork, stable.commit, change.path),
        github.readFile(fork, patchBranch.sha, change.path)
      ])
      if (atMerge !== atFix) differing.push(change.path)
    }
    return differing.length > 0 ? differing.toSorted() : undefined
  }

  async function prepare(run: PatchRun): Promise<Transition> {
    const { release, fork, fix, stable, pullRequest, input } = released(run, settings)
    let changes: FileChange[]
    try {
      changes = await diffChanges(fix.diff, (path) =>
        github.readFile(fork, release.commit.sha, path)
      )
    } catch (error) {
      if (!(error instanceof DiffError)) throw error
      return blocked(
        `The fix does not apply to the upstream release commit ${release.commit.sha} (${error.message}), so the agent can't open the upstream pull request. Open it by hand from ${pullRequest.url}.`
      )
    }
    const differing = await differences(run, changes)
    if (differing) {
      return blocked(
        `The merge of ${pullRequest.url} (${stable.commit}) differs from the agent's fix in ${differing.join(', ')}, so the agent can't vouch for an upstream pull request built from its fix. Open it by hand from the merged change.`
      )
    }
    const base = await github.defaultBranch(release.repository)
    if (!base) throw new Error(`${repoName(release.repository)} is gone or not public`)
    const name = upstreamBranchName(run.packageName, release.version, run.ghsaId)
    const sha = await github.createBranch(fork, {
      name,
      parent: release.commit.sha,
      message: upstreamCommitMessage(input),
      changes
    })
    const upstream = {
      ...pending,
      branch: { name, sha },
      base,
      compareUrl: compareUrl(release.repository, base, fork, name)
    }
    if (isTestAdvisory(run.ghsaId)) {
      const reason = `${run.ghsaId} is a patchtogo test advisory, so the agent never proposes its fix upstream. ${name} in ${repoName(fork)} holds what the upstream pull request would contain; don't open one on ${repoName(release.repository)}.`
      return { to: 'released', reason, details: { upstream: { ...upstream, blocked: reason } } }
    }
    return {
      to: 'released',
      reason: `Pushed ${name} to ${repoName(fork)}: the fix and its regression test on top of ${repoName(release.repository)}@${release.commit.sha.slice(0, 7)}.`,
      details: { upstream }
    }
  }

  async function propose(
    run: PatchRun,
    upstream: UpstreamProposal
  ): Promise<Transition | undefined> {
    const notification = { runId: run.id, ghsaId: run.ghsaId, packageName: run.packageName }
    const next = { to: 'released' as const, details: { upstream: { ...upstream, notified: true } } }
    if (upstream.blocked) {
      if (upstream.notified) return undefined
      await notifier.notify({
        type: 'upstream-pr-blocked',
        ...notification,
        reason: upstream.blocked
      })
      return { ...next, reason: upstream.blocked }
    }
    const { release, fork, input } = released(run, settings)
    const { branch, base } = upstream
    if (!branch || !base || !upstream.compareUrl) {
      throw new Error(`patch run ${run.id} has no upstream branch`)
    }
    const found = await github.findPullRequestFrom(release.repository, {
      owner: fork.owner,
      branch: branch.name
    })
    if (found) return upstreamed(upstream, found)
    if (upstreamAccount) {
      const opened = await upstreamAccount.openPullRequest(release.repository, {
        head: `${fork.owner}:${branch.name}`,
        base,
        title: upstreamPrTitle(run),
        body: upstreamPrBody(input)
      })
      await notifier.notify({ type: 'upstream-pr-opened', ...notification, url: opened.url })
      return upstreamed(upstream, opened)
    }
    if (upstream.notified) return undefined
    await notifier.notify({
      type: 'upstream-pr-ready',
      ...notification,
      compareUrl: upstream.compareUrl
    })
    return {
      ...next,
      reason: `Waiting for a human to open the upstream pull request from ${upstream.compareUrl}. Retry the run once it is open.`
    }
  }

  return {
    async released(run) {
      return run.upstream ? propose(run, run.upstream) : prepare(run)
    }
  }
}
