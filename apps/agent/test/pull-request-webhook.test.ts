import { Webhooks } from '@octokit/webhooks'
import { describe, expect, it } from 'vitest'
import type { PipelineEvent } from '../src/pipeline/events.ts'
import { forwardPullRequestFeedback } from '../src/pull-request-webhook.ts'
import { createServer } from '../src/server.ts'

const head = 'ptg/patch/escape-html/1.0.3/ghsa-gxr4-xjj5-5px2'
const repository = { name: 'escape-html', owner: { login: 'patchtogo-ai' } }
const pullRequest = { repository: { owner: 'patchtogo-ai', repo: 'escape-html' }, number: 1, head }
const prUrl = 'https://github.com/patchtogo-ai/escape-html/pull/1'
const alice = { login: 'alice', type: 'User' }

function feedbackWebhook() {
  const webhooks = new Webhooks({ secret: 'test-secret' })
  const events: PipelineEvent[] = []
  const heads: Record<number, string> = { 1: head, 2: 'main' }
  forwardPullRequestFeedback(
    webhooks,
    async (event) => {
      events.push(event)
    },
    { pullRequestHead: async (_repo, number) => heads[number] }
  )

  const app = createServer(webhooks)

  async function deliver(name: string, payload: object, options: { signedBody?: string } = {}) {
    const body = JSON.stringify(payload)
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-delivery': 'delivery-1',
        'x-github-event': name,
        'x-hub-signature-256': await webhooks.sign(options.signedBody ?? body),
        'content-type': 'application/json'
      },
      payload: body
    })
    return { status: response.statusCode }
  }

  return { events, deliver }
}

const issueComment = (number: number, user = alice, pull = true) => ({
  action: 'created',
  repository,
  issue: { number, ...(pull ? { pull_request: { url: 'https://api.github.com/x' } } : {}) },
  comment: { id: 11, user, body: 'Please escape > too.', html_url: `${prUrl}#issuecomment-11` }
})

const pullRequestPayload = { number: 1, head: { ref: head } }

describe('pull request feedback webhook', () => {
  it.each<[string, string, object, PipelineEvent]>([
    [
      'a comment on a patch PR',
      'issue_comment',
      issueComment(1),
      {
        type: 'pull-request-commented',
        pullRequest,
        comment: {
          id: 11,
          author: { login: 'alice', bot: false },
          body: 'Please escape > too.',
          url: `${prUrl}#issuecomment-11`
        }
      }
    ],
    [
      'a comment by a bot',
      'issue_comment',
      issueComment(1, { login: 'patchtogo-bot[bot]', type: 'Bot' }),
      {
        type: 'pull-request-commented',
        pullRequest,
        comment: {
          id: 11,
          author: { login: 'patchtogo-bot[bot]', bot: true },
          body: 'Please escape > too.',
          url: `${prUrl}#issuecomment-11`
        }
      }
    ],
    [
      'a submitted review',
      'pull_request_review',
      {
        action: 'submitted',
        repository,
        pull_request: pullRequestPayload,
        review: { id: 21, user: alice }
      },
      {
        type: 'review-submitted',
        pullRequest,
        review: { id: 21, author: { login: 'alice', bot: false } }
      }
    ],
    [
      'an inline review comment',
      'pull_request_review_comment',
      {
        action: 'created',
        repository,
        pull_request: pullRequestPayload,
        comment: {
          id: 31,
          pull_request_review_id: 21,
          user: alice,
          body: 'Escape > here too.',
          html_url: `${prUrl}#discussion_r31`,
          path: 'index.js',
          line: 1
        }
      },
      {
        type: 'review-comment-created',
        pullRequest,
        reviewId: 21,
        comment: {
          id: 31,
          author: { login: 'alice', bot: false },
          body: 'Escape > here too.',
          url: `${prUrl}#discussion_r31`,
          path: 'index.js',
          line: 1
        }
      }
    ],
    [
      'a label',
      'pull_request',
      {
        action: 'labeled',
        repository,
        pull_request: pullRequestPayload,
        label: { name: 'patchtogo: hand over' },
        sender: alice
      },
      {
        type: 'pull-request-labeled',
        pullRequest,
        label: 'patchtogo: hand over',
        sender: { login: 'alice', bot: false }
      }
    ]
  ])('turns %s into a pipeline event', async (_case, name, payload, event) => {
    const { events, deliver } = feedbackWebhook()

    const response = await deliver(name, payload)

    expect(response.status).toBe(202)
    expect(events).toEqual([event])
  })

  it.each([
    ['a comment on an issue', issueComment(1, alice, false)],
    ['a comment on a pull request that is not a patch PR', issueComment(2)]
  ])('forwards nothing for %s', async (_case, payload) => {
    const { events, deliver } = feedbackWebhook()

    await deliver('issue_comment', payload)

    expect(events).toEqual([])
  })

  it('rejects a delivery signed for another body without emitting anything', async () => {
    const { events, deliver } = feedbackWebhook()

    const response = await deliver('issue_comment', issueComment(1), {
      signedBody: JSON.stringify(issueComment(1, { login: 'mallory', type: 'User' }))
    })

    expect(response.status).toBe(401)
    expect(events).toEqual([])
  })
})
