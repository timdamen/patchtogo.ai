import type { PollCursor } from '../../src/advisory-poller.ts'

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
