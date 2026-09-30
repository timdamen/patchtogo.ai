import { patchedPackageName, type NamingSettings } from '../naming.ts'
import { STABLE_WORKFLOW_NAME } from '../stable-workflow.ts'
import { repoName } from '../upstream.ts'
import type { PatchRun, Step } from './patch-run.ts'
import type { GitHub, Ports, RepoRef, ReviewRule } from './ports.ts'

const REQUIRED_APPROVALS = 2

function enforcesReview(rule: ReviewRule): boolean {
  return (
    rule.approvals >= REQUIRED_APPROVALS &&
    rule.codeOwnerReview &&
    rule.lastPushApproval &&
    rule.bypass === 'never'
  )
}

export async function unprotectedBranch(
  github: GitHub,
  repo: RepoRef,
  branch: string
): Promise<string | undefined> {
  const rules = await github.branchReviewRules(repo, branch)
  if (rules.some(enforcesReview)) return undefined
  return [
    `${branch} in ${repoName(repo)} is not protected: no active ruleset requires ${REQUIRED_APPROVALS} approvals, a code owner review and approval of the last push without letting patchtogo bypass it.`,
    'Create the organisation ruleset from the operator setup (https://patchtogo.ai/operations#protect-the-base-branches-once), then retry the run.'
  ].join(' ')
}

function workflowRuns(fork: RepoRef, branch: string): string {
  const query = encodeURIComponent(`branch:${branch}`)
  return `https://github.com/${repoName(fork)}/actions/workflows/${STABLE_WORKFLOW_NAME}?query=${query}`
}

function trustCommand(name: string, fork: RepoRef): string {
  return `npm trust github ${name} --repo ${repoName(fork)} --file ${STABLE_WORKFLOW_NAME} --allow-publish --yes`
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

export function releasingSteps({ registry }: Ports, settings: NamingSettings): { approved: Step } {
  return {
    async approved(run) {
      const { stable, fork, baseBranch } = run
      if (!stable || !fork || !baseBranch) {
        throw new Error(`patch run ${run.id} has no merged patch PR to release`)
      }
      const name = patchedPackageName(run.packageName, settings)
      const published = await registry.getPackage(name)
      const version = published?.versions.find((v) => v.gitHead === stable.commit)
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
          `The stable release workflow succeeded (${workflow.url}), but npm shows no version of ${name} built from ${stable.commit}. Either npm hasn't caught up yet, or the workflow's gate found no merged patch PR for that commit and published nothing. Retry the run once the version shows up, or re-run the workflow.`
        )
      }
      throw new Error(
        `The stable release workflow ended with ${workflow.conclusion}: ${workflow.url}. If npm refused the publish (ENEEDAUTH, E403 or E404), check the trusted publisher of ${name} (${trustCommand(name, fork)}). Re-run its failed jobs; the run resumes when it succeeds.`
      )
    }
  }
}
