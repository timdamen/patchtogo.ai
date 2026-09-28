import type { Webhooks } from '@octokit/webhooks'
import type { PipelineEvent } from './pipeline/events.ts'

export function forwardSecurityAdvisories(
  webhooks: Webhooks,
  emit: (event: PipelineEvent) => Promise<void>
): void {
  webhooks.on(['security_advisory.published', 'security_advisory.updated'], ({ payload }) =>
    emit({ type: 'advisory-published', ghsaId: payload.security_advisory.ghsa_id })
  )
}
