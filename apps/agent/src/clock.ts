import { setTimeout } from 'node:timers/promises'
import type { Clock } from './pipeline/ports.ts'

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: async (milliseconds) => {
    await setTimeout(milliseconds)
  }
}
