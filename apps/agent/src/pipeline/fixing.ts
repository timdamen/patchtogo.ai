import { patchBranchName, type NamingSettings } from '../naming.ts'
import { patchCommitMessage, patchPrBody, patchPrTitle } from '../patch-pr.ts'
import { DiffError, diffChanges } from '../unified-diff.ts'
import { repoName } from '../upstream.ts'
import type { FixOutcome, PatchRun, RunState, Step, Transition } from './patch-run.ts'
import type { FixRequest, FixResult, Ports, RunCost } from './ports.ts'

export interface FixSettings extends NamingSettings {
  forkOrg: string
  reviewerTeam: string
}

const REASON_LIMIT = 1500

export function clip(text: string): string {
  return text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT)}…` : text
}

function prepared(run: PatchRun) {
  const { triage, release, fork, baseBranch } = run
  if (!triage || !release || !fork || !baseBranch) {
    throw new Error(`patch run ${run.id} has no triage, fork or base branch to fix`)
  }
  return { triage, release, fork, baseBranch }
}

export function outcomeOf(result: FixResult): FixOutcome {
  return {
    sessionId: result.session.id,
    diff: result.diff,
    regressionBefore: result.regressionBefore,
    regressionAfter: result.regressionAfter,
    upstreamTests: result.upstreamTests,
    summary: result.summary
  }
}

export function redToGreenProblem(fix: FixOutcome): string | undefined {
  const problems = [
    ...(fix.regressionBefore.passed ? ['passes on the base branch'] : []),
    ...(fix.regressionAfter.passed ? [] : ['fails with the fix'])
  ]
  if (problems.length > 0) {
    return `The fixer did not produce a red-to-green regression test: it ${problems.join(' and ')}.`
  }
  if (!fix.diff.trim()) return 'The fixer reported red-to-green but its diff is empty.'
  return undefined
}

export function fixCost(runId: string, step: RunState, { cost }: FixResult, at: Date): RunCost {
  return {
    runId,
    step,
    inputTokens: cost.inputTokens + cost.cacheReadTokens + cost.cacheWriteTokens,
    outputTokens: cost.outputTokens,
    costUsd: cost.usd,
    sandboxSeconds: cost.sandboxSeconds,
    at
  }
}

export async function fixWithToken(
  { fixer, modelAccess }: Pick<Ports, 'fixer' | 'modelAccess'>,
  request: Omit<FixRequest, 'modelToken'>
): Promise<FixResult> {
  const grant = await modelAccess.grant(request.runId)
  try {
    return await fixer.fix({ ...request, modelToken: grant.token })
  } finally {
    await grant.revoke()
  }
}

export function fixingSteps(ports: Ports, settings: FixSettings): { fixing: Step } {
  const { github, store, notifier, clock } = ports

  async function runFixer(run: PatchRun): Promise<Transition> {
    const { triage, fork, baseBranch } = prepared(run)
    const result = await fixWithToken(ports, {
      runId: run.id,
      advisory: run.advisory,
      triage,
      source: { repository: repoName(fork), branch: baseBranch.sha },
      instructions: [],
      untrustedContext: []
    })
    await store.recordCost(fixCost(run.id, run.state, result, clock.now()))
    await store.saveSession(run.id, result.session)
    const fix = outcomeOf(result)
    const problem = redToGreenProblem(fix)
    if (problem) {
      return { to: 'needs-human', reason: `${problem}\n\n${clip(fix.summary)}`, details: { fix } }
    }
    return {
      to: 'fixing',
      reason: 'The regression test goes red to green; opening the patch PR.',
      details: { fix }
    }
  }

  async function openPatchPr(run: PatchRun, fix: FixOutcome): Promise<Transition> {
    const { triage, release, fork, baseBranch } = prepared(run)
    const name = patchBranchName(run.packageName, release.version, run.ghsaId)
    let sha = await github.getBranch(fork, name)
    if (!sha) {
      let changes
      try {
        changes = await diffChanges(fix.diff, (path) => github.readFile(fork, baseBranch.sha, path))
      } catch (error) {
        if (!(error instanceof DiffError)) throw error
        return {
          to: 'needs-human',
          reason: `The fixer's diff cannot be applied to ${baseBranch.name}: ${error.message}`
        }
      }
      sha = await github.createBranch(fork, {
        name,
        parent: baseBranch.sha,
        message: patchCommitMessage(run, release),
        changes
      })
    }
    const pullRequest =
      (await github.findPullRequest(fork, name)) ??
      (await github.openPullRequest(fork, {
        head: name,
        base: baseBranch.name,
        title: patchPrTitle(run, release),
        body: patchPrBody({
          run,
          triage,
          release,
          fork,
          baseBranch: baseBranch.name,
          patchCommit: sha,
          fix,
          settings
        })
      }))
    await github.requestTeamReview(fork, pullRequest.number, settings.reviewerTeam)
    await notifier.notify({
      type: 'patch-pr-opened',
      runId: run.id,
      ghsaId: run.ghsaId,
      packageName: run.packageName,
      url: pullRequest.url
    })
    return {
      to: 'in-review',
      reason: `Opened ${pullRequest.url} and requested review from ${settings.forkOrg}/${settings.reviewerTeam}.`,
      details: { patchBranch: { name, sha }, pullRequest }
    }
  }

  return {
    async fixing(run) {
      return run.fix ? openPatchPr(run, run.fix) : runFixer(run)
    }
  }
}
