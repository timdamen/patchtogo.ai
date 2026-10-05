import type { SecurityAdvisory } from '../advisory.ts'
import type { PatchRun } from './patch-run.ts'
import {
  StaleRunError,
  type FixSession,
  type RunCost,
  type RunEvent,
  type RunFilter,
  type Store
} from './ports.ts'

function eventOf(run: PatchRun): RunEvent {
  return {
    runId: run.id,
    version: run.version,
    state: run.state,
    reason: run.reason,
    failure: run.failure,
    at: run.updatedAt
  }
}

export class InMemoryStore implements Store {
  #runs = new Map<string, PatchRun>()
  #events: RunEvent[] = []
  #costs: RunCost[] = []
  #sessions = new Map<string, FixSession>()
  #testAdvisories = new Map<string, SecurityAdvisory>()

  createRunIfAbsent(run: PatchRun): Promise<PatchRun> {
    let stored = this.#runs.get(run.id)
    if (!stored) {
      stored = structuredClone(run)
      this.#runs.set(run.id, stored)
      this.#events.push(structuredClone(eventOf(stored)))
    }
    return Promise.resolve(structuredClone(stored))
  }

  getRun(id: string): Promise<PatchRun | undefined> {
    const run = this.#runs.get(id)
    return Promise.resolve(run && structuredClone(run))
  }

  listRuns(filter: RunFilter = {}): Promise<PatchRun[]> {
    const runs = [...this.#runs.values()].filter(
      (run) =>
        (filter.ghsaId === undefined || run.ghsaId === filter.ghsaId) &&
        (filter.state === undefined || run.state === filter.state)
    )
    return Promise.resolve(runs.map((run) => structuredClone(run)))
  }

  saveRun(run: PatchRun): Promise<void> {
    const stored = this.#runs.get(run.id)
    if (!stored || stored.version !== run.version - 1) {
      return Promise.reject(
        new StaleRunError(`patch run ${run.id} changed since version ${run.version - 1}`)
      )
    }
    this.#runs.set(run.id, structuredClone(run))
    this.#events.push(structuredClone(eventOf(run)))
    return Promise.resolve()
  }

  listEvents(runId: string): Promise<RunEvent[]> {
    return Promise.resolve(
      this.#events.filter((event) => event.runId === runId).map((event) => structuredClone(event))
    )
  }

  recordCost(cost: RunCost): Promise<void> {
    if (!this.#runs.has(cost.runId)) {
      return Promise.reject(new Error(`no patch run ${cost.runId}`))
    }
    this.#costs.push(structuredClone(cost))
    return Promise.resolve()
  }

  listCosts(runId: string): Promise<RunCost[]> {
    return Promise.resolve(
      this.#costs.filter((cost) => cost.runId === runId).map((cost) => structuredClone(cost))
    )
  }

  saveSession(runId: string, session: FixSession): Promise<void> {
    if (!this.#runs.has(runId)) return Promise.reject(new Error(`no patch run ${runId}`))
    this.#sessions.set(runId, structuredClone(session))
    return Promise.resolve()
  }

  getSession(runId: string): Promise<FixSession | undefined> {
    const session = this.#sessions.get(runId)
    return Promise.resolve(session && structuredClone(session))
  }

  saveTestAdvisory(advisory: SecurityAdvisory): Promise<void> {
    this.#testAdvisories.set(advisory.ghsaId, structuredClone(advisory))
    return Promise.resolve()
  }

  getTestAdvisory(ghsaId: string): Promise<SecurityAdvisory | undefined> {
    const advisory = this.#testAdvisories.get(ghsaId)
    return Promise.resolve(advisory && structuredClone(advisory))
  }
}
