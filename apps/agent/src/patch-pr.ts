import { patchedPackageName, type NamingSettings } from './naming.ts'
import type { FixOutcome, PatchRun, UpstreamRelease } from './pipeline/patch-run.ts'
import type { RepoRef, TestResult } from './pipeline/ports.ts'
import { previewInstallUrl } from './preview-workflow.ts'
import type { Triage } from './triage.ts'
import { repoName } from './upstream.ts'

export interface PatchPrInput {
  run: PatchRun
  triage: Triage
  release: UpstreamRelease
  fork: RepoRef
  baseBranch: string
  patchCommit: string
  fix: FixOutcome
  settings: NamingSettings & { forkOrg: string; reviewerTeam: string }
}

const OUTPUT_LIMIT = 4000
const TEXT_LIMIT = 6000

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `[${text.length - limit} characters cut]\n${text.slice(-limit)}`
}

function fenced(text: string, limit = TEXT_LIMIT): string {
  const body = clip(text.trim() || '(empty)', limit)
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${body}\n${fence}`
}

function code(text: string): string {
  return `\`${text.replaceAll('`', "'").replaceAll(/[\r\n]+/g, ' ')}\``
}

function details(summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`
}

function outcome(result: TestResult, expected: 'fail' | 'pass'): string {
  const failed = !result.passed
  const verdict = failed ? 'fails' : 'passes'
  const as = (expected === 'fail') === failed ? 'as required' : 'NOT as required'
  return `${verdict}, ${as}`
}

export function patchPrTitle(run: PatchRun, release: UpstreamRelease): string {
  return `fix: close ${run.ghsaId} in ${run.packageName}@${release.version}`
}

export function patchCommitMessage(run: PatchRun, release: UpstreamRelease): string {
  return [
    patchPrTitle(run, release),
    '',
    'Fix and exploit regression test written by the patchtogo fixer, applied on the base branch.',
    '',
    `Patchtogo-Advisory: ${run.ghsaId}`,
    `Patchtogo-Run: ${run.id}`
  ].join('\n')
}

export function patchPrBody({
  run,
  triage,
  release,
  fork,
  baseBranch,
  patchCommit,
  fix,
  settings
}: PatchPrInput): string {
  const { advisory } = run
  const patched = patchedPackageName(run.packageName, settings)
  const upstreamCommit = `https://github.com/${repoName(release.repository)}/commit/${release.commit.sha}`
  const cve = advisory.cveId
    ? `[${advisory.cveId}](https://www.cve.org/CVERecord?id=${encodeURIComponent(advisory.cveId)})`
    : 'none'
  return [
    '> [!CAUTION]',
    '> **Unreviewed preview.** This patch was written by an AI agent and has not been reviewed yet.',
    `> Preview builds of this pull request are not approved by the reviewer team: use one only as an emergency stopgap.`,
    `> A stable \`${patched}\` release is published only after two reviewer approvals and a human merge.`,
    '',
    `Unreviewed preview of the patch commit ${patchCommit.slice(0, 7)}, published by [pkg.pr.new](https://pkg.pr.new) once the preview workflow has run:`,
    '',
    '```sh',
    `npm i ${previewInstallUrl(fork, patched, patchCommit)}`,
    '```',
    '',
    'Later commits on this branch get their own install link in the pkg.pr.new comment below.',
    '',
    '## Vulnerability',
    '',
    '| | |',
    '| --- | --- |',
    `| Advisory | [${advisory.ghsaId}](https://github.com/advisories/${encodeURIComponent(advisory.ghsaId)}) |`,
    `| CVE | ${cve} |`,
    `| Severity | ${advisory.severity} |`,
    `| Package | ${code(run.packageName)}, vulnerable range ${code(advisory.vulnerableRange ?? 'unknown')} |`,
    `| Patched release | ${code(`${run.packageName}@${release.version}`)} from [${repoName(release.repository)}@${release.commit.sha.slice(0, 7)}](${upstreamCommit}) |`,
    `| Published as | ${code(patched)} |`,
    '',
    'The advisory text below comes from the GitHub Advisory Database and is shown verbatim.',
    '',
    fenced(advisory.summary),
    '',
    details('Advisory description', fenced(advisory.description)),
    '',
    '## Triage',
    '',
    `Decision: **${triage.decision}**. The reasoning and strategy are model output:`,
    '',
    fenced(triage.reason),
    '',
    'Suspected files:',
    '',
    fenced(triage.suspectedFiles.join('\n') || '(none)'),
    '',
    '## Fix strategy',
    '',
    'Triage proposed:',
    '',
    fenced(triage.fixStrategy || '(none)'),
    '',
    "The fixer's summary of what it changed:",
    '',
    fenced(fix.summary),
    '',
    '## Test results',
    '',
    'Re-run by the fixer runner after the session ended, not reported by the model.',
    '',
    '| Check | Result |',
    '| --- | --- |',
    `| Regression test on the base branch | ${outcome(fix.regressionBefore, 'fail')} |`,
    `| Regression test with the fix | ${outcome(fix.regressionAfter, 'pass')} |`,
    `| Upstream test suite with the fix | ${fix.upstreamTests.passed ? 'passes' : '**fails**'} |`,
    '',
    details('Regression test before the fix', fenced(fix.regressionBefore.output, OUTPUT_LIMIT)),
    '',
    details('Regression test after the fix', fenced(fix.regressionAfter.output, OUTPUT_LIMIT)),
    '',
    details('Upstream test suite', fenced(fix.upstreamTests.output, OUTPUT_LIMIT)),
    '',
    '## Review',
    '',
    `This pull request targets ${code(baseBranch)} in ${repoName(fork)}, which holds the upstream release plus the patchtogo scaffolding. Its diff contains only the fix and the regression test.`,
    `Review is requested from the ${code(`${settings.forkOrg}/${settings.reviewerTeam}`)} team. Merging needs two approvals from the team and is done by a human, never by the agent.`,
    '',
    `<sub>patchtogo run ${code(run.id)}, fix session ${code(fix.sessionId)}</sub>`
  ].join('\n')
}
