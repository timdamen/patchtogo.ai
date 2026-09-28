import { npmAdvisories } from '../advisory.ts'
import { triageAdvisory, type Triage } from '../triage.ts'
import type { PipelineEvent } from './events.ts'
import { forkingSteps, type ForkSettings } from './forking.ts'
import {
  newPatchRun,
  retry,
  transition,
  type PatchRun,
  type RunState,
  type Step,
  type Transition
} from './patch-run.ts'
import { StaleRunError, type Ports } from './ports.ts'

export interface Pipeline {
  handle(event: PipelineEvent): Promise<void>
}

export type PipelineSettings = ForkSettings

const triageOutcomes = {
  patch: 'forking',
  skip: 'skipped',
  'needs-human': 'needs-human'
} as const satisfies Record<Triage['decision'], RunState>

export function createPipeline(ports: Ports, settings: PipelineSettings): Pipeline {
  const { github, model, store, notifier, clock } = ports

  const steps: Partial<Record<RunState, Step>> = {
    async detected(run) {
      const { triage, usage } = await triageAdvisory(model, run.advisory)
      if (usage) {
        await store.recordCost({
          runId: run.id,
          step: run.state,
          ...usage,
          costUsd: null,
          sandboxSeconds: 0,
          at: clock.now()
        })
      }
      return { to: 'triaged', reason: triage.reason, details: { triage } }
    },
    async triaged(run) {
      if (!run.triage) throw new Error(`patch run ${run.id} has no triage`)
      return { to: triageOutcomes[run.triage.decision], reason: run.triage.reason }
    },
    ...forkingSteps(ports, settings)
  }

  async function attempt(step: Step, run: PatchRun): Promise<Transition | undefined> {
    try {
      const next = await step(run)
      if (next?.to === 'needs-human') {
        await notifier.notify({
          type: 'needs-human',
          runId: run.id,
          ghsaId: run.ghsaId,
          packageName: run.packageName,
          reason: next.reason ?? 'no reason given'
        })
      }
      return next
    } catch (error) {
      return { to: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async function save(run: PatchRun): Promise<boolean> {
    try {
      await store.saveRun(run)
      return true
    } catch (error) {
      if (error instanceof StaleRunError) return false
      throw error
    }
  }

  async function advance(run: PatchRun): Promise<void> {
    let current = run
    for (let step = steps[current.state]; step; step = steps[current.state]) {
      const next = await attempt(step, current)
      if (!next) return
      const updated = transition(current, next, clock.now())
      if (!(await save(updated))) return
      current = updated
    }
  }

  async function advisoryPublished(ghsaId: string): Promise<void> {
    const advisory = await github.getAdvisory(ghsaId)
    if (!advisory) return
    for (const packageAdvisory of npmAdvisories(advisory)) {
      await advance(await store.createRunIfAbsent(newPatchRun(packageAdvisory, clock.now())))
    }
  }

  async function retryRequested(id: string): Promise<void> {
    const run = await store.getRun(id)
    if (!run) throw new Error(`no patch run ${id}`)
    const resumed = retry(run, clock.now())
    if (await save(resumed)) await advance(resumed)
  }

  return {
    async handle(event) {
      switch (event.type) {
        case 'advisory-published':
          return advisoryPublished(event.ghsaId)
        case 'retry-requested':
          return retryRequested(event.runId)
      }
    }
  }
}
