import type { Clock } from '../../src/pipeline/ports.ts'

export class FakeClock implements Clock {
  #now: Date
  #wake: (() => void) | undefined

  constructor(start = new Date('2026-01-01T00:00:00Z')) {
    this.#now = start
  }

  now(): Date {
    return new Date(this.#now)
  }

  advance(milliseconds: number): void {
    this.#now = new Date(this.#now.getTime() + milliseconds)
  }

  onNextSleep(wake: () => void): void {
    this.#wake = wake
  }

  sleep(milliseconds: number): Promise<void> {
    this.advance(milliseconds)
    const wake = this.#wake
    this.#wake = undefined
    wake?.()
    return Promise.resolve()
  }
}
