import { ghsaIdOfPatchBranch } from '../naming.ts'
import {
  handOverReply,
  iterationCommitMessage,
  iterationReply,
  someoneElsePushed
} from '../review-reply.ts'
import { classifyFeedback } from '../comment-classification.ts'
import { DiffError, diffChanges } from '../unified-diff.ts'
import { repoName, sameRepository } from '../upstream.ts'
import type { Automation } from './automation.ts'
import type {
  Author,
  PatchPullRequestRef,
  PullRequestFeedback,
  PullRequestLabeled
} from './events.ts'
import {
  clip,
  fixCost,
  fixWithToken,
  outcomeOf,
  redToGreenProblem,
  type FixSettings
} from './fixing.ts'
import {
  annotate,
  type Feedback,
  type FixOutcome,
  type Iteration,
  type IterationVerdict,
  type PatchRun,
  type ReviewLoop,
  type Step,
  type Transition
} from './patch-run.ts'
import type { Ports, Review, ReviewComment } from './ports.ts'

export const HAND_OVER_COMMAND = '/patchtogo hand-over'

export const HAND_OVER_LABEL = 'patchtogo: hand over'

const CONTEXT_LIMIT = 20

const TEXT_LIMIT = 8000

export interface ReviewSettings extends FixSettings {
  automation: Automation
}

interface Received {
  key: string
  author: Author
  url: string
  bodies: string[]
  text: string
}

const emptyReview: ReviewLoop = {
  seen: [],
  instructions: [],
  context: [],
  iterations: 0,
  current: null,
  handOver: null
}

function reviewOf(run: PatchRun): ReviewLoop {
  return run.review ?? emptyReview
}

function limited(text: string): string {
  return text.length > TEXT_LIMIT
    ? `${text.slice(0, TEXT_LIMIT)}\n[cut after ${TEXT_LIMIT} characters]`
    : text
}

function asksForHandOver(bodies: string[]): boolean {
  return bodies.some((body) =>
    body.split(/\r?\n/).some((line) => line.trim().toLowerCase() === HAND_OVER_COMMAND)
  )
}

function acceptsFeedback(run: PatchRun): boolean {
  return run.state === 'in-review' || (run.state === 'failed' && run.failure?.step === 'in-review')
}

function inReview(run: PatchRun) {
  const { triage, fork, baseBranch, patchBranch, pullRequest, fix } = run
  if (!triage || !fork || !baseBranch || !patchBranch || !pullRequest || !fix) {
    throw new Error(`patch run ${run.id} has no open patch PR to iterate on`)
  }
  return { triage, fork, baseBranch, patchBranch, pullRequest, fix }
}

function commentText(heading: string, url: string, body: string): string {
  return `${heading} (${url}):\n\n${limited(body.trim())}`
}

function reviewCommentHeading(comment: ReviewComment): string {
  return comment.line === null
    ? `Comment on ${comment.path}`
    : `Comment on ${comment.path} line ${comment.line}`
}

function single(
  key: string,
  comment: { author: Author; body: string; url: string },
  heading: string
): Received | undefined {
  if (!comment.body.trim()) return undefined
  return {
    key,
    author: comment.author,
    url: comment.url,
    bodies: [comment.body],
    text: commentText(heading, comment.url, comment.body)
  }
}

function reviewReceived(key: string, review: Review): Received | undefined {
  if (review.state !== 'commented' && review.state !== 'changes_requested') return undefined
  const state = review.state === 'changes_requested' ? 'requested changes' : 'commented'
  const parts = [
    ...(review.body.trim()
      ? [commentText(`Review by @${review.author.login} (${state})`, review.url, review.body)]
      : []),
    ...review.comments
      .filter((comment) => comment.body.trim())
      .map((comment) => commentText(reviewCommentHeading(comment), comment.url, comment.body))
  ]
  if (parts.length === 0) return undefined
  return {
    key,
    author: review.author,
    url: review.url,
    bodies: [review.body, ...review.comments.map((comment) => comment.body)],
    text: parts.join('\n\n')
  }
}

type CommentEvent = Exclude<PullRequestFeedback, PullRequestLabeled>

function authorOf(event: PullRequestFeedback): Author {
  switch (event.type) {
    case 'pull-request-commented':
    case 'review-comment-created':
      return event.comment.author
    case 'review-submitted':
      return event.review.author
    case 'pull-request-labeled':
      return event.sender
  }
}

function keyOf(event: CommentEvent): string {
  switch (event.type) {
    case 'pull-request-commented':
      return `comment:${event.comment.id}`
    case 'review-submitted':
      return `review:${event.review.id}`
    case 'review-comment-created':
      return event.reviewId === null
        ? `review-comment:${event.comment.id}`
        : `review:${event.reviewId}`
  }
}

function keep(review: ReviewLoop, current: Iteration, reason: string): Transition {
  return { to: 'in-review', reason, details: { review: { ...review, current } } }
}

export function reviewLoop(ports: Ports, settings: ReviewSettings) {
  const { github, store, clock } = ports

  async function runFor(pullRequest: PatchPullRequestRef): Promise<PatchRun | undefined> {
    const ghsaId = ghsaIdOfPatchBranch(pullRequest.head)
    if (!ghsaId) return undefined
    const runs = await store.listRuns({ ghsaId })
    return runs.find(
      (run) =>
        run.fork !== undefined &&
        sameRepository(run.fork, pullRequest.repository) &&
        run.patchBranch?.name === pullRequest.head &&
        run.pullRequest?.number === pullRequest.number
    )
  }

  async function received(event: CommentEvent, run: PatchRun): Promise<Received | undefined> {
    const key = keyOf(event)
    if (event.type === 'pull-request-commented') {
      return single(key, event.comment, `Comment by @${event.comment.author.login}`)
    }
    if (event.type === 'review-comment-created' && event.reviewId === null) {
      return single(key, event.comment, reviewCommentHeading(event.comment))
    }
    const reviewId = event.type === 'review-submitted' ? event.review.id : event.reviewId
    if (reviewId === null) return undefined
    const review = await github.getReview(inReview(run).fork, event.pullRequest.number, reviewId)
    return review && reviewReceived(key, review)
  }

  async function labeled(
    event: PullRequestLabeled,
    run: PatchRun,
    review: ReviewLoop
  ): Promise<ReviewLoop | undefined> {
    if (event.label !== HAND_OVER_LABEL || !(await isReviewer(event.sender))) return undefined
    return { ...review, handOver: { by: event.sender.login, url: inReview(run).pullRequest.url } }
  }

  async function commented(
    event: CommentEvent,
    run: PatchRun,
    review: ReviewLoop
  ): Promise<ReviewLoop | undefined> {
    if (review.seen.includes(keyOf(event))) return undefined
    const feedback = await received(event, run)
    if (!feedback) return undefined
    const entry: Feedback = {
      key: feedback.key,
      author: feedback.author.login,
      url: feedback.url,
      text: feedback.text
    }
    const seen = [...review.seen, entry.key]
    if (!(await isReviewer(feedback.author))) {
      return { ...review, seen, context: [...review.context, entry].slice(-CONTEXT_LIMIT) }
    }
    if (asksForHandOver(feedback.bodies)) {
      return { ...review, seen, handOver: { by: entry.author, url: entry.url } }
    }
    return { ...review, seen, instructions: [...review.instructions, entry] }
  }

  async function record(
    event: PullRequestFeedback
  ): Promise<{ run: PatchRun; iterate: boolean } | undefined> {
    if (authorOf(event).bot) return undefined
    const run = await runFor(event.pullRequest)
    if (!run || !acceptsFeedback(run)) return undefined
    const review = reviewOf(run)
    if (review.handOver) return undefined
    const next =
      event.type === 'pull-request-labeled'
        ? await labeled(event, run, review)
        : await commented(event, run, review)
    if (!next) return undefined
    const updated = annotate(run, { review: next }, clock.now())
    await store.saveRun(updated)
    const iterate = next.handOver !== null || next.instructions.length > review.instructions.length
    return { run: updated, iterate: iterate && updated.state === 'in-review' }
  }

  function isReviewer(author: Author): Promise<boolean> {
    return github.isTeamMember(settings.forkOrg, settings.reviewerTeam, author.login)
  }

  async function judge(
    run: PatchRun,
    previous: FixOutcome,
    fix: FixOutcome
  ): Promise<{ verdict: IterationVerdict; reason: string | null }> {
    const problem = redToGreenProblem(fix)
    if (problem) return { verdict: 'rejected', reason: problem }
    if (fix.diff === previous.diff) return { verdict: 'unchanged', reason: null }
    const { fork, baseBranch } = inReview(run)
    try {
      await diffChanges(fix.diff, (path) => github.readFile(fork, baseBranch.sha, path))
    } catch (error) {
      if (!(error instanceof DiffError)) throw error
      return {
        verdict: 'rejected',
        reason: `The new diff cannot be applied to ${baseBranch.name}: ${error.message}`
      }
    }
    return { verdict: 'push', reason: null }
  }

  async function startIteration(run: PatchRun, review: ReviewLoop): Promise<Transition> {
    const { triage, fork, baseBranch, patchBranch, fix } = inReview(run)
    const iteration: Iteration = {
      number: review.iterations + 1,
      feedback: review.instructions,
      verdict: 'blocked',
      reason: null,
      fix: null,
      commit: null,
      pushed: false
    }
    const { classification, usage } = await classifyFeedback(
      ports.smallModel,
      review.instructions.map((feedback) => feedback.text)
    )
    await store.recordCost({
      runId: run.id,
      step: run.state,
      ...usage,
      costUsd: null,
      sandboxSeconds: 0,
      at: clock.now()
    })
    if (!classification.actionable) {
      return keep(
        { ...review, instructions: [] },
        { ...iteration, verdict: 'answered', reason: classification.reply },
        `Review iteration ${iteration.number}: the feedback asks for no change, so it gets a reply without a fix.`
      )
    }
    const drained = { ...review, instructions: [], context: [] }
    const head = await github.getBranch(fork, patchBranch.name)
    if (head !== patchBranch.sha) {
      const reason = someoneElsePushed(patchBranch, head)
      return keep(drained, { ...iteration, reason }, reason)
    }
    const session = await store.getSession(run.id)
    if (!session) throw new Error(`patch run ${run.id} has no stored fix session to resume`)
    const result = await fixWithToken(ports, {
      runId: run.id,
      advisory: run.advisory,
      triage,
      source: { repository: repoName(fork), branch: baseBranch.sha },
      instructions: review.instructions.map((feedback) => feedback.text),
      untrustedContext: review.context.map((feedback) => feedback.text),
      resume: { session, diff: fix.diff }
    })
    await store.recordCost(fixCost(run.id, run.state, result, clock.now()))
    const outcome = outcomeOf(result)
    const { verdict, reason } = await judge(run, fix, outcome)
    if (verdict !== 'rejected') await store.saveSession(run.id, result.session)
    return keep(
      drained,
      { ...iteration, verdict, reason, fix: outcome },
      `Review iteration ${iteration.number}: the fixer finished (${verdict}).`
    )
  }

  async function push(run: PatchRun, review: ReviewLoop, current: Iteration): Promise<Transition> {
    const { fork, baseBranch, patchBranch } = inReview(run)
    const fix = current.fix
    if (!fix) throw new Error(`review iteration ${current.number} of ${run.id} has no fix to push`)
    if (!current.commit) {
      const changes = await diffChanges(fix.diff, (path) =>
        github.readFile(fork, baseBranch.sha, path)
      )
      const commit = await github.createCommit(fork, {
        parent: patchBranch.sha,
        treeFrom: baseBranch.sha,
        message: iterationCommitMessage(run, current),
        changes
      })
      return keep(
        review,
        { ...current, commit },
        `Review iteration ${current.number}: committed ${commit}.`
      )
    }
    const moved = await github.moveBranch(fork, patchBranch.name, {
      from: patchBranch.sha,
      to: current.commit
    })
    if (!moved) {
      const reason = someoneElsePushed(patchBranch, await github.getBranch(fork, patchBranch.name))
      return keep(review, { ...current, verdict: 'blocked', reason }, reason)
    }
    return {
      to: 'in-review',
      reason: `Review iteration ${current.number}: pushed ${current.commit} to ${patchBranch.name}.`,
      details: {
        fix,
        patchBranch: { ...patchBranch, sha: current.commit },
        review: { ...review, current: { ...current, pushed: true } }
      }
    }
  }

  async function reply(run: PatchRun, review: ReviewLoop, current: Iteration): Promise<Transition> {
    const { fork, pullRequest } = inReview(run)
    await github.commentOnPullRequest(fork, pullRequest.number, iterationReply(current, fork))
    const done = { ...review, iterations: current.number, current: null }
    if (current.verdict === 'blocked') {
      return { to: 'needs-human', reason: current.reason ?? undefined, details: { review: done } }
    }
    const outcome = {
      push: `pushed ${current.commit}`,
      answered: 'replied without a fix',
      unchanged: 'no code change',
      rejected: `nothing pushed: ${clip(current.reason ?? '')}`
    }[current.verdict]
    return {
      to: 'in-review',
      reason: `Review iteration ${current.number} answered: ${outcome}.`,
      details: { review: done }
    }
  }

  const step: Step = async (run) => {
    const review = reviewOf(run)
    if (review.handOver) {
      const { fork, pullRequest } = inReview(run)
      await github.commentOnPullRequest(fork, pullRequest.number, handOverReply(review.handOver))
      return {
        to: 'needs-human',
        reason: `Handed over to humans by @${review.handOver.by}: ${review.handOver.url}`
      }
    }
    if (settings.automation !== 'full') return undefined
    const { current } = review
    if (current) {
      if (current.verdict === 'push' && !current.pushed) return push(run, review, current)
      return reply(run, review, current)
    }
    if (review.instructions.length > 0) return startIteration(run, review)
    return undefined
  }

  return { record, step, runFor }
}
