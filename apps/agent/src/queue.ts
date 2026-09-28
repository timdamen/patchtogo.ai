import type { PgBoss } from 'pg-boss'
import type { PipelineEvent } from './pipeline/events.ts'
import { ghsaIdOf } from './pipeline/patch-run.ts'

const PIPELINE_QUEUE = 'pipeline'
const HEARTBEAT_SECONDS = 60

export interface PipelineQueueOptions {
  concurrency: number
  timeoutSeconds: number
  retryLimit?: number
  retryDelaySeconds?: number
  pollingIntervalSeconds?: number
}

export interface PipelineQueue {
  send(event: PipelineEvent): Promise<void>
  work(handle: (event: PipelineEvent) => Promise<void>): Promise<void>
  retryFailedJobs(ghsaId: string): Promise<number>
  failedKeys(): Promise<string[]>
}

function eventKey(event: PipelineEvent): string {
  switch (event.type) {
    case 'advisory-published':
      return event.ghsaId
    case 'retry-requested':
      return ghsaIdOf(event.runId)
  }
}

export async function createPipelineQueue(
  boss: PgBoss,
  options: PipelineQueueOptions
): Promise<PipelineQueue> {
  const {
    concurrency,
    timeoutSeconds,
    retryLimit = 3,
    retryDelaySeconds = 30,
    pollingIntervalSeconds = 2
  } = options
  const settings = {
    expireInSeconds: timeoutSeconds,
    retryLimit,
    retryDelay: retryDelaySeconds,
    retryBackoff: retryDelaySeconds > 0,
    heartbeatSeconds: HEARTBEAT_SECONDS
  }
  if (await boss.getQueue(PIPELINE_QUEUE)) {
    await boss.updateQueue(PIPELINE_QUEUE, settings)
  } else {
    await boss.createQueue(PIPELINE_QUEUE, { policy: 'key_strict_fifo', ...settings })
  }

  return {
    async send(event) {
      const id = await boss.send(PIPELINE_QUEUE, event, { singletonKey: eventKey(event) })
      if (!id) throw new Error(`the pipeline queue refused ${JSON.stringify(event)}`)
    },
    async work(handle) {
      await boss.work<PipelineEvent>(
        PIPELINE_QUEUE,
        { localConcurrency: concurrency, batchSize: 1, pollingIntervalSeconds },
        async ([job]) => {
          if (job) await handle(job.data)
        }
      )
    },
    async retryFailedJobs(ghsaId) {
      const jobs = await boss.findJobs(PIPELINE_QUEUE, { key: ghsaId })
      const failed = jobs.filter((job) => job.state === 'failed').map((job) => job.id)
      if (failed.length > 0) await boss.retry(PIPELINE_QUEUE, failed)
      return failed.length
    },
    failedKeys() {
      return boss.getBlockedKeys(PIPELINE_QUEUE)
    }
  }
}
