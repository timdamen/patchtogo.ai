import type { Clock } from '../../src/pipeline/ports.ts'

export class FakeClock implements Clock {
  #now: Date

  constructor(start = new Date('2026-01-01T00:00:00Z')) {
    this.#now = start
  }

  now(): Date {
    return new Date(this.#now)
  }

  advance(milliseconds: number): void {
    this.#now = new Date(this.#now.getTime() + milliseconds)
  }
}
