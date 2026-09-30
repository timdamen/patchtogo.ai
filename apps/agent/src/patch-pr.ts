import { patchedPackageName, type NamingSettings } from './naming.ts'
import type { FixOutcome, PatchRun, UpstreamRelease } from './pipeline/patch-run.ts'
import type { RepoRef, TestResult, UpstreamTests } from './pipeline/ports.ts'
import { approvals, type ReviewSettings } from './pipeline/releasing.ts'
import { previewInstallUrl } from './preview-workflow.ts'
import { isTestAdvisory, testMarked } from './test-advisories.ts'
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
  settings: NamingSettings & ReviewSettings & { forkOrg: string }
}

const OUTPUT_LIMIT = 4000
const TEXT_LIMIT = 6000

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `[${text.length - limit} characters cut]\n${text.slice(-limit)}`
}

export function fenced(text: string, limit = TEXT_LIMIT): string {
  const body = clip(text.trim() || '(empty)', limit)
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${body}\n${fence}`
}

export function code(text: string): string {
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

function passes(result: TestResult): string {
  return result.passed ? 'passes' : 'fails'
}

function upstreamRows(tests: UpstreamTests): string[] {
  switch (tests.suite) {
    case 'none':
      return ['| Upstream test suite | no upstream test suite |']
    case 'not-run':
      return ['| Upstream test suite | **not run** |']
    case 'ran': {
      const { before, after } = tests
      const withFix = after.passed
        ? 'passes'
        : before.passed
          ? '**fails**, but passes on the base branch'
          : 'fails, as on the base branch'
      return [
        `| Upstream test suite on the base branch | ${passes(before)} |`,
        `| Upstream test suite with the fix | ${withFix} |`
      ]
    }
  }
}

export function upstreamTestDetails(tests: UpstreamTests): string[] {
  if (tests.suite !== 'ran') return [details('Upstream test suite', fenced(tests.reason))]
  return [
    details('Upstream test suite on the base branch', fenced(tests.before.output, OUTPUT_LIMIT)),
    '',
    details('Upstream test suite with the fix', fenced(tests.after.output, OUTPUT_LIMIT))
  ]
}

export function testResultTable(fix: FixOutcome): string[] {
  return [
    '| Check | Result |',
    '| --- | --- |',
    `| Regression test on the base branch | ${outcome(fix.regressionBefore, 'fail')} |`,
    `| Regression test with the fix | ${outcome(fix.regressionAfter, 'pass')} |`,
    ...upstreamRows(fix.upstreamTests)
  ]
}

export function patchPrTitle(run: PatchRun, release: UpstreamRelease): string {
  return testMarked(`fix: close ${run.ghsaId} in ${run.packageName}@${release.version}`, run.ghsaId)
}

export function testBanner(ghsaId: string): string[] {
  if (!isTestAdvisory(ghsaId)) return []
  return [
    '> [!WARNING]',
    `> **patchtogo test.** ${ghsaId} is a test advisory that a patchtogo operator made up to exercise the pipeline end to end. It is not in the GitHub Advisory Database, and the vulnerability it describes may not exist.`,
    ''
  ]
}

function advisoryLink(ghsaId: string): string {
  return isTestAdvisory(ghsaId)
    ? `${ghsaId} (patchtogo test advisory, not in the GitHub Advisory Database)`
    : `[${ghsaId}](https://github.com/advisories/${encodeURIComponent(ghsaId)})`
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
    ...testBanner(run.ghsaId),
    '> [!CAUTION]',
    '> **Unreviewed preview.** This patch was written by an AI agent and has not been reviewed yet.',
    `> Preview builds of this pull request are not approved by the reviewer team: use one only as an emergency stopgap.`,
    `> A stable \`${patched}\` release is published only after ${approvals(settings.requiredApprovals)} from the reviewer team and a human merge.`,
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
    `| Advisory | ${advisoryLink(advisory.ghsaId)} |`,
    `| CVE | ${cve} |`,
    `| Severity | ${advisory.severity} |`,
    `| Package | ${code(run.packageName)}, vulnerable range ${code(advisory.vulnerableRange ?? 'unknown')} |`,
    `| Patched release | ${code(`${run.packageName}@${release.version}`)} from [${repoName(release.repository)}@${release.commit.sha.slice(0, 7)}](${upstreamCommit}) |`,
    `| Published as | ${code(patched)} |`,
    ...(run.basedOn
      ? [
          `| Builds on | ${code(`${patched}@${run.basedOn.version}`)}, the latest stable release (${run.basedOn.commit.slice(0, 7)}), so its earlier fixes stay |`
        ]
      : []),
    '',
    isTestAdvisory(advisory.ghsaId)
      ? 'The advisory text below comes from the test advisory and is shown verbatim.'
      : 'The advisory text below comes from the GitHub Advisory Database and is shown verbatim.',
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
    ...testResultTable(fix),
    '',
    details('Regression test before the fix', fenced(fix.regressionBefore.output, OUTPUT_LIMIT)),
    '',
    details('Regression test after the fix', fenced(fix.regressionAfter.output, OUTPUT_LIMIT)),
    '',
    ...upstreamTestDetails(fix.upstreamTests),
    '',
    '## Review',
    '',
    `This pull request targets ${code(baseBranch)} in ${repoName(fork)}, which holds the upstream release plus the patchtogo scaffolding. Its diff contains only the fix and the regression test.`,
    `Review is requested from the ${code(`${settings.forkOrg}/${settings.reviewerTeam}`)} team. Merging needs ${approvals(settings.requiredApprovals)} from the team and is done by a human, never by the agent.`,
    '',
    `<sub>patchtogo run ${code(run.id)}, fix session ${code(fix.sessionId)}</sub>`
  ].join('\n')
}
