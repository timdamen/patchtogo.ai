import type { RepoRef } from './ports.ts'

export interface AdvisoryPublished {
  type: 'advisory-published'
  ghsaId: string
}

export interface RetryRequested {
  type: 'retry-requested'
  runId: string
}

export interface PatchPullRequestRef {
  repository: RepoRef
  number: number
  head: string
}

export interface Author {
  login: string
  bot: boolean
}

export interface PullRequestCommented {
  type: 'pull-request-commented'
  pullRequest: PatchPullRequestRef
  comment: { id: number; author: Author; body: string; url: string }
}

export interface ReviewSubmitted {
  type: 'review-submitted'
  pullRequest: PatchPullRequestRef
  review: { id: number; author: Author }
}

export interface ReviewCommentCreated {
  type: 'review-comment-created'
  pullRequest: PatchPullRequestRef
  reviewId: number | null
  comment: {
    id: number
    author: Author
    body: string
    url: string
    path: string
    line: number | null
  }
}

export interface PullRequestLabeled {
  type: 'pull-request-labeled'
  pullRequest: PatchPullRequestRef
  label: string
  sender: Author
}

export type PullRequestFeedback =
  | PullRequestCommented
  | ReviewSubmitted
  | ReviewCommentCreated
  | PullRequestLabeled

export type PipelineEvent = AdvisoryPublished | RetryRequested | PullRequestFeedback
