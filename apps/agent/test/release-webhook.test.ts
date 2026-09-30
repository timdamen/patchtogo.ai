import { Webhooks } from '@octokit/webhooks'
import { describe, expect, it } from 'vitest'
import type { PipelineEvent } from '../src/pipeline/events.ts'
import { forwardStableReleases } from '../src/release-webhook.ts'
import { createServer } from '../src/server.ts'

const fork = { name: 'escape-html', owner: { login: 'patchtogo-ai' } }
const merge = 'a'.repeat(40)

function workflowRunCompleted(path: string) {
  return {
    action: 'completed',
    repository: fork,
    workflow_run: {
      id: 42,
      html_url: 'https://github.com/patchtogo-ai/escape-html/actions/runs/42',
      path,
      event: 'push',
      conclusion: 'failure',
      head_branch: 'ptg/base/escape-html/1.0.3',
      head_sha: merge,
      head_repository: fork
    }
  }
}

async function deliver(payload: object): Promise<PipelineEvent[]> {
  const webhooks = new Webhooks({ secret: 'test-secret' })
  const events: PipelineEvent[] = []
  forwardStableReleases(webhooks, async (event) => {
    events.push(event)
  })
  const body = JSON.stringify(payload)
  const response = await createServer(webhooks).inject({
    method: 'POST',
    url: '/webhooks/github',
    headers: {
      'x-github-delivery': 'delivery-1',
      'x-github-event': 'workflow_run',
      'x-hub-signature-256': await webhooks.sign(body),
      'content-type': 'application/json'
    },
    payload: body
  })
  expect(response.statusCode).toBe(202)
  return events
}

describe('stable release webhook', () => {
  it('turns a completed stable release workflow run into a pipeline event', async () => {
    expect(await deliver(workflowRunCompleted('.github/workflows/patchtogo-release.yml'))).toEqual([
      {
        type: 'stable-release-completed',
        repository: { owner: 'patchtogo-ai', repo: 'escape-html' },
        headRepository: { owner: 'patchtogo-ai', repo: 'escape-html' },
        trigger: 'push',
        branch: 'ptg/base/escape-html/1.0.3',
        commit: merge,
        workflowRun: {
          id: 42,
          url: 'https://github.com/patchtogo-ai/escape-html/actions/runs/42',
          conclusion: 'failure'
        }
      }
    ])
  })

  it('ignores runs of other workflows', async () => {
    expect(await deliver(workflowRunCompleted('.github/workflows/patchtogo-preview.yml'))).toEqual(
      []
    )
  })
})
