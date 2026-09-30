import { patchedPackageName, type NamingSettings } from '../naming.ts'
import { CODEOWNERS_FILE } from '../scaffolding.ts'
import { RELEASE_ENVIRONMENT, STABLE_WORKFLOW_NAME } from '../stable-workflow.ts'
import { repoName } from '../upstream.ts'
import type { PatchRun, Step } from './patch-run.ts'
import type { GitHub, Ports, RepoRef, ReviewRule } from './ports.ts'

const REQUIRED_APPROVALS = 2

const everyFile = new Set(['*', '**', '**/*'])

function enforcesReview(rule: ReviewRule): boolean {
  return (
    rule.approvals >= REQUIRED_APPROVALS &&
    rule.codeOwnerReview &&
    rule.lastPushApproval &&
    rule.bypass === 'never'
  )
}

function teamApprovesEverything(rule: ReviewRule, team: string): boolean {
  return rule.teamReviews.some(
    (review) =>
      review.team === team &&
      review.approvals >= REQUIRED_APPROVALS &&
      review.filePatterns.some((pattern) => everyFile.has(pattern))
  )
}

function onlyTeamOwns(codeOwners: string | undefined, owner: string): boolean {
  const rules = (codeOwners ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
  return (
    rules.some(([pattern]) => pattern === '*') &&
    rules.every(
      ([, ...owners]) => owners.length === 1 && owners[0]?.toLowerCase() === owner.toLowerCase()
    )
  )
}

export async function unprotectedBranch(
  github: GitHub,
  repo: RepoRef,
  branch: string,
  team: string
): Promise<string | undefined> {
  const rules = await github.branchReviewRules(repo, branch)
  const enforced = rules.filter(enforcesReview)
  if (enforced.some((rule) => teamApprovesEverything(rule, team))) return undefined
  const teamReviewsUnavailable = rules.every((rule) => rule.teamReviews.length === 0)
  if (
    enforced.length > 0 &&
    teamReviewsUnavailable &&
    onlyTeamOwns(await github.readFile(repo, branch, CODEOWNERS_FILE), `@${repo.owner}/${team}`)
  ) {
    return undefined
  }
  return [
    `${branch} in ${repoName(repo)} is not protected: no active ruleset requires ${REQUIRED_APPROVALS} approvals from ${repo.owner}/${team} on every file, a code owner review and approval of the last push without letting patchtogo bypass it.`,
    `Without team reviewers in the ruleset, ${CODEOWNERS_FILE} on the branch has to name only @${repo.owner}/${team}.`,
    'Create the organisation ruleset from the operator setup (https://patchtogo.ai/operations#protect-the-base-branches-once), then retry the run.'
  ].join(' ')
}

function workflowRuns(fork: RepoRef, branch: string): string {
  const query = encodeURIComponent(`branch:${branch}`)
  return `https://github.com/${repoName(fork)}/actions/workflows/${STABLE_WORKFLOW_NAME}?query=${query}`
}

function trustCommand(name: string, fork: RepoRef): string {
  return `npm trust github ${name} --repo ${repoName(fork)} --file ${STABLE_WORKFLOW_NAME} --environment ${RELEASE_ENVIRONMENT.name} --allow-publish --yes`
}

function firstPublish(run: PatchRun, name: string, fork: RepoRef, branch: string): string {
  return [
    `${name} does not exist on npm yet, and npm trusted publishing can only be set up for a package that exists. The stable release workflow cannot publish it until an owner of the npm scope has done this once, with npm 11.15 or later and 2FA:`,
    '',
    '1. Publish a placeholder:',
    '   mkdir ptg-seed && cd ptg-seed && npm init -y >/dev/null',
    `   npm pkg set name=${name} version=0.0.0-ptg.0 description="patchtogo placeholder, not a release" repository.type=git repository.url=git+https://github.com/${repoName(fork)}.git`,
    '   npm publish --access public --tag bootstrap',
    `   npm deprecate ${name}@0.0.0-ptg.0 "patchtogo placeholder, not a release"`,
    '2. Trust the stable release workflow:',
    `   ${trustCommand(name, fork)}`,
    `3. On npmjs.com, set the publishing access of ${name} to "Require two-factor authentication and disallow tokens".`,
    `4. Re-run the failed jobs of the stable release workflow for ${branch}: ${workflowRuns(fork, branch)}`,
    '',
    `The run moves to released when that workflow succeeds. If it doesn't, \`pnpm --filter agent retry ${run.id}\` checks npm again.`
  ].join('\n')
}

const NPM_RECHECKS_MS = [15_000, 30_000, 60_000, 120_000]

export function releasingSteps(
  { registry, clock }: Ports,
  settings: NamingSettings
): { approved: Step } {
  async function releaseOf(name: string, commit: string) {
    const published = await registry.getPackage(name)
    return { published, version: published?.versions.find((v) => v.gitHead === commit) }
  }

  return {
    async approved(run) {
      const { stable, fork, baseBranch } = run
      if (!stable || !fork || !baseBranch) {
        throw new Error(`patch run ${run.id} has no merged patch PR to release`)
      }
      const name = patchedPackageName(run.packageName, settings)
      let { published, version } = await releaseOf(name, stable.commit)
      if (published && stable.workflow?.conclusion === 'success') {
        for (const wait of NPM_RECHECKS_MS) {
          if (version) break
          await clock.sleep(wait)
          ;({ published, version } = await releaseOf(name, stable.commit))
        }
      }
      if (version) {
        return {
          to: 'released',
          reason: `Published ${name}@${version.version} from ${stable.commit}.`,
          details: { stable: { ...stable, version: version.version } }
        }
      }
      if (!published) {
        return { to: 'needs-human', reason: firstPublish(run, name, fork, baseBranch.name) }
      }
      const { workflow } = stable
      if (!workflow) return undefined
      if (workflow.conclusion === 'success') {
        throw new Error(
          `The stable release workflow succeeded (${workflow.url}), but npm still shows no version of ${name} built from ${stable.commit} after ${NPM_RECHECKS_MS.reduce((sum, wait) => sum + wait, 0) / 60_000} minutes of rechecking. Either npm is unusually slow, or the workflow's gate found no merged patch PR for that commit and published nothing. Retry the run once the version shows up, or re-run the workflow.`
        )
      }
      throw new Error(
        `The stable release workflow ended with ${workflow.conclusion}: ${workflow.url}. If npm refused the publish (ENEEDAUTH, E403 or E404), check the trusted publisher of ${name} (${trustCommand(name, fork)}). Re-run its failed jobs; the run resumes when it succeeds.`
      )
    }
  }
}
