import { code, fenced } from './patch-pr.ts'
import { testMarked } from './test-advisories.ts'
import type { FixOutcome, PatchRun, UpstreamRelease } from './pipeline/patch-run.ts'
import type { PullRequest, RepoRef } from './pipeline/ports.ts'
import { repoName } from './upstream.ts'

export interface UpstreamPrInput {
  run: PatchRun
  release: UpstreamRelease
  fix: FixOutcome
  patchPullRequest: PullRequest
  published: string
}

export function upstreamPrTitle(run: PatchRun): string {
  const cve = run.advisory.cveId ? ` (${run.advisory.cveId})` : ''
  return testMarked(`fix: close ${run.ghsaId}${cve}`, run.ghsaId)
}

export function upstreamPrBody({
  run,
  release,
  fix,
  patchPullRequest,
  published
}: UpstreamPrInput): string {
  const { advisory } = run
  const link = `[${advisory.ghsaId}](https://github.com/advisories/${encodeURIComponent(advisory.ghsaId)})`
  const cve = advisory.cveId ? `, ${advisory.cveId}` : ''
  return [
    `This fixes ${link} (${advisory.severity}${cve}) in ${code(`${run.packageName}@${release.version}`)}. It contains only the fix and a regression test for it.`,
    '',
    `The regression test fails on ${code(release.version)} and passes with the fix. The patchtogo reviewer team reviewed the change in ${patchPullRequest.url}, and it is published as ${code(published)} for users who cannot wait for a release.`,
    '',
    'What changed, as summarised by the patchtogo fixer (an AI agent):',
    '',
    fenced(fix.summary),
    '',
    `The branch starts at the ${code(release.version)} release commit ${release.commit.sha.slice(0, 7)}, so it may need a rebase. [patchtogo](https://patchtogo.ai) publishes reviewed fixes for npm vulnerabilities that have no upstream patch yet. Once a release of ${code(run.packageName)} fixes this advisory, patchtogo deprecates its package and points its users back here. Feel free to adapt the change, take it over or close this pull request.`
  ].join('\n')
}

export function upstreamCommitMessage(input: UpstreamPrInput): string {
  return `${upstreamPrTitle(input.run)}\n\n${upstreamPrBody(input)}`
}

export function compareUrl(upstream: RepoRef, base: string, fork: RepoRef, branch: string): string {
  return `https://github.com/${repoName(upstream)}/compare/${encodeURI(`${base}...${fork.owner}:${fork.repo}:${branch}`)}?expand=1`
}
