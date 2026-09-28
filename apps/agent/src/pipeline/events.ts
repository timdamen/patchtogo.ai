export interface AdvisoryPublished {
  type: 'advisory-published'
  ghsaId: string
}

export interface RetryRequested {
  type: 'retry-requested'
  runId: string
}

export type PipelineEvent = AdvisoryPublished | RetryRequested
