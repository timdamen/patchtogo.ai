import { code, fenced, testResultTable } from './patch-pr.ts'
import type { BaseBranch, Iteration, PatchRun } from './pipeline/patch-run.ts'
import type { MarkedComment, RepoRef } from './pipeline/ports.ts'
import { repoName } from './upstream.ts'

const SUMMARY_LIMIT = 4000

function marked(marker: string, lines: string[]): MarkedComment {
  return { marker, body: [`<!-- ${marker} -->`, ...lines].join('\n') }
}

function short(sha: string): string {
  return sha.slice(0, 7)
}

export function iterationCommitMessage(run: PatchRun, iteration: Iteration): string {
  return [
    `fix: address review feedback on ${run.ghsaId} (iteration ${iteration.number})`,
    '',
    'Follow-up by the patchtogo fixer, asked for in:',
    '',
    ...iteration.feedback.map((feedback) => `- ${feedback.url}`),
    '',
    `Patchtogo-Advisory: ${run.ghsaId}`,
    `Patchtogo-Run: ${run.id}`,
    `Patchtogo-Iteration: ${iteration.number}`
  ].join('\n')
}

export function someoneElsePushed(patchBranch: BaseBranch, head: string | undefined): string {
  const now = head ? `points at ${short(head)}` : 'is gone'
  return `The patch branch ${patchBranch.name} ${now} instead of patchtogo's last commit ${short(patchBranch.sha)}: someone else changed it. patchtogo never overwrites other people's commits, so it stopped iterating and handed the pull request over to humans.`
}

function outcomeLines(iteration: Iteration, fork: RepoRef): string[] {
  const { fix, commit } = iteration
  const summary = fix
    ? ["The fixer's summary (model output):", '', fenced(fix.summary, SUMMARY_LIMIT)]
    : []
  switch (iteration.verdict) {
    case 'push': {
      const sha = commit ?? ''
      const link = `[${code(short(sha))}](https://github.com/${repoName(fork)}/commit/${sha})`
      return [
        `Pushed ${link} to this pull request. Its preview build is as unreviewed as the first one.`,
        '',
        ...summary,
        '',
        ...(fix ? testResultTable(fix) : [])
      ]
    }
    case 'unchanged':
      return ['No code change: the patch stays as it is.', '', ...summary]
    case 'rejected':
      return [
        'Nothing was pushed:',
        '',
        fenced(iteration.reason ?? ''),
        '',
        ...summary,
        '',
        ...(fix ? testResultTable(fix) : [])
      ]
    case 'blocked':
      return [`Nothing was pushed. ${iteration.reason ?? ''}`]
  }
}

export function iterationReply(iteration: Iteration, fork: RepoRef): MarkedComment {
  const asked = iteration.feedback
    .map((feedback) => `[feedback from ${code(`@${feedback.author}`)}](${feedback.url})`)
    .join(', ')
  return marked(`patchtogo:iteration:${iteration.number}`, [
    `**Review iteration ${iteration.number}** for ${asked}.`,
    '',
    ...outcomeLines(iteration, fork)
  ])
}

export function handOverReply(handOver: { by: string; url: string }): MarkedComment {
  return marked('patchtogo:hand-over', [
    `Handed over to humans at the request of ${code(`@${handOver.by}`)} ([link](${handOver.url})).`,
    'patchtogo stops working on this pull request: it will not push commits or answer comments here any more.'
  ])
}
