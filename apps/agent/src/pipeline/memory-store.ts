import type { PatchRun } from './patch-run.ts'
import { StaleRunError, type RunFilter, type Store } from './ports.ts'

export class InMemoryStore implements Store {
  #runs = new Map<string, PatchRun>()

  createRunIfAbsent(run: PatchRun): Promise<PatchRun> {
    const stored = this.#runs.get(run.id) ?? structuredClone(run)
    this.#runs.set(run.id, stored)
    return Promise.resolve(structuredClone(stored))
  }

  getRun(id: string): Promise<PatchRun | undefined> {
    const run = this.#runs.get(id)
    return Promise.resolve(run && structuredClone(run))
  }

  listRuns(filter: RunFilter = {}): Promise<PatchRun[]> {
    const runs = [...this.#runs.values()].filter(
      (run) => filter.ghsaId === undefined || run.ghsaId === filter.ghsaId
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
    return Promise.resolve()
  }
}
