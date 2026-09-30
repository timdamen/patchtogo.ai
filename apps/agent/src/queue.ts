import { randomBytes } from 'node:crypto'
import type { PgBoss } from 'pg-boss'
import type { PipelineEvent } from './pipeline/events.ts'
import { ghsaIdOfPatchBranch } from './naming.ts'
import { ghsaIdOf } from './pipeline/patch-run.ts'
import { repoName } from './upstream.ts'

const PIPELINE_QUEUE = 'pipeline'
const HEARTBEAT_SECONDS = 60
const OPEN_JOB_STATES = new Set(['created', 'retry', 'active', 'failed'])

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
  hasOpenJob(event: PipelineEvent): Promise<boolean>
}

function eventKey(event: PipelineEvent): string {
  switch (event.type) {
    case 'advisory-published':
      return event.ghsaId
    case 'retry-requested':
      return ghsaIdOf(event.runId)
    case 'stable-release-completed':
      return repoName(event.repository)
    case 'upstream-version-published':
      return `npm:${event.packageName}`
    default:
      return (
        ghsaIdOfPatchBranch(event.pullRequest.head) ??
        `${repoName(event.pullRequest.repository)}#${event.pullRequest.number}`
      )
  }
}

function sendOrderedIds(): () => string {
  let lastMs = 0
  let counter = 0
  return () => {
    const now = Date.now()
    if (now > lastMs) {
      lastMs = now
      counter = 0
    } else if (++counter > 0xfff) {
      lastMs++
      counter = 0
    }
    const bytes = randomBytes(16)
    bytes.writeUIntBE(lastMs, 0, 6)
    bytes.writeUInt16BE(0x7000 | counter, 6)
    bytes.writeUInt8(0x80 | (bytes.readUInt8(8) & 0x3f), 8)
    const hex = bytes.toString('hex')
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join('-')
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

  const nextId = sendOrderedIds()

  return {
    async send(event) {
      const id = await boss.send(PIPELINE_QUEUE, event, {
        id: nextId(),
        singletonKey: eventKey(event)
      })
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
    },
    async hasOpenJob(event) {
      const jobs = await boss.findJobs(PIPELINE_QUEUE, { key: eventKey(event) })
      return jobs.some((job) => OPEN_JOB_STATES.has(job.state))
    }
  }
}
