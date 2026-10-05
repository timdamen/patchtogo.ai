import type { Webhooks } from '@octokit/webhooks'
import { authorOf, type PullRequestHeads } from './github-app.ts'
import { ghsaIdOfPatchBranch } from './naming.ts'
import type { PatchPullRequestRef, PipelineEvent } from './pipeline/events.ts'

interface RepositoryPayload {
  name: string
  owner: { login: string }
}

function patchPullRequest(
  repository: RepositoryPayload,
  number: number,
  head: string | undefined
): PatchPullRequestRef | undefined {
  if (!head || !ghsaIdOfPatchBranch(head)) return undefined
  return { repository: { owner: repository.owner.login, repo: repository.name }, number, head }
}

export function forwardPullRequestFeedback(
  webhooks: Webhooks,
  emit: (event: PipelineEvent) => Promise<void>,
  { pullRequestHead }: PullRequestHeads
): void {
  webhooks.on('issue_comment.created', async ({ payload }) => {
    const { issue, comment, repository } = payload
    if (!issue.pull_request) return
    const head = await pullRequestHead(
      { owner: repository.owner.login, repo: repository.name },
      issue.number
    )
    const pullRequest = patchPullRequest(repository, issue.number, head)
    if (!pullRequest) return
    await emit({
      type: 'pull-request-commented',
      pullRequest,
      comment: {
        id: comment.id,
        author: authorOf(comment.user),
        body: comment.body,
        url: comment.html_url
      }
    })
  })

  webhooks.on('pull_request_review.submitted', async ({ payload }) => {
    const { pull_request, review, repository } = payload
    const pullRequest = patchPullRequest(repository, pull_request.number, pull_request.head.ref)
    if (!pullRequest) return
    await emit({
      type: 'review-submitted',
      pullRequest,
      review: { id: review.id, author: authorOf(review.user) }
    })
  })

  webhooks.on('pull_request_review_comment.created', async ({ payload }) => {
    const { pull_request, comment, repository } = payload
    const pullRequest = patchPullRequest(repository, pull_request.number, pull_request.head.ref)
    if (!pullRequest) return
    await emit({
      type: 'review-comment-created',
      pullRequest,
      reviewId: comment.pull_request_review_id,
      comment: {
        id: comment.id,
        author: authorOf(comment.user),
        body: comment.body,
        url: comment.html_url,
        path: comment.path,
        line: comment.line ?? null
      }
    })
  })

  webhooks.on('pull_request.labeled', async ({ payload }) => {
    const { pull_request, label, sender, repository } = payload
    const pullRequest = patchPullRequest(repository, pull_request.number, pull_request.head.ref)
    if (!pullRequest || !label) return
    await emit({
      type: 'pull-request-labeled',
      pullRequest,
      label: label.name,
      sender: authorOf(sender)
    })
  })

  webhooks.on('pull_request.closed', async ({ payload }) => {
    const { pull_request, repository } = payload
    const pullRequest = patchPullRequest(repository, pull_request.number, pull_request.head.ref)
    if (!pullRequest) return
    await emit({
      type: 'pull-request-closed',
      pullRequest,
      mergeCommit: pull_request.merged ? pull_request.merge_commit_sha : null
    })
  })
}
