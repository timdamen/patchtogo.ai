import type { Webhooks } from '@octokit/webhooks'
import type { PipelineEvent } from './pipeline/events.ts'
import { STABLE_WORKFLOW_FILE } from './stable-workflow.ts'

export function forwardStableReleases(
  webhooks: Webhooks,
  emit: (event: PipelineEvent) => Promise<void>
): void {
  webhooks.on('workflow_run.completed', async ({ payload }) => {
    const { workflow_run: run, repository } = payload
    const head = run.head_repository
    if (run.path !== STABLE_WORKFLOW_FILE || !run.conclusion || !run.head_branch || !head.owner) {
      return
    }
    await emit({
      type: 'stable-release-completed',
      repository: { owner: repository.owner.login, repo: repository.name },
      headRepository: { owner: head.owner.login, repo: head.name },
      trigger: run.event,
      branch: run.head_branch,
      commit: run.head_sha,
      workflowRun: { id: run.id, url: run.html_url, conclusion: run.conclusion }
    })
  })
}
