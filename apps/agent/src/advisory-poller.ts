import type { AdvisoryUpdate } from './github-advisories.ts'
import type { PipelineEvent } from './pipeline/events.ts'

export interface PollCursor {
  get(): Promise<Date>
  set(value: Date): Promise<void>
}

export class InMemoryPollCursor implements PollCursor {
  #value: Date

  constructor(initial: Date) {
    this.#value = new Date(initial)
  }

  get(): Promise<Date> {
    return Promise.resolve(new Date(this.#value))
  }

  set(value: Date): Promise<void> {
    this.#value = new Date(value)
    return Promise.resolve()
  }
}

export interface AdvisoryPollerOptions {
  updatedSince(since: Date): AsyncIterable<AdvisoryUpdate[]>
  cursor: PollCursor
  emit(event: PipelineEvent): Promise<void>
}

export interface AdvisoryPoller {
  poll(): Promise<number>
}

export function createAdvisoryPoller({
  updatedSince,
  cursor,
  emit
}: AdvisoryPollerOptions): AdvisoryPoller {
  return {
    async poll() {
      let since = await cursor.get()
      let emitted = 0
      for await (const page of updatedSince(since)) {
        for (const { ghsaId } of page) {
          await emit({ type: 'advisory-published', ghsaId })
          emitted++
        }
        const latest = Math.max(since.getTime(), ...page.map((a) => a.updatedAt.getTime()))
        if (latest > since.getTime()) {
          since = new Date(latest)
          await cursor.set(since)
        }
      }
      return emitted
    }
  }
}
