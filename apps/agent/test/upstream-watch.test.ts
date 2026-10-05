import { describe, expect, it } from 'vitest'
import type { PipelineEvent } from '../src/pipeline/events.ts'
import { InMemoryStore } from '../src/pipeline/memory-store.ts'
import { newPatchRun, type PatchRun, type RunState } from '../src/pipeline/patch-run.ts'
import { createUpstreamWatch } from '../src/upstream-watch.ts'
import { FakeRegistry } from './fakes/registry.ts'

function runOf(packageName: string, state: RunState, failedAt?: RunState): PatchRun {
  const run = newPatchRun(
    {
      ghsaId: 'GHSA-gxr4-xjj5-5px2',
      cveId: null,
      packageName,
      vulnerableRange: '<= 1.0.3',
      patchedVersion: null,
      severity: 'moderate',
      summary: 'XSS',
      description: 'XSS'
    },
    new Date('2026-09-01T00:00:00Z')
  )
  return { ...run, state, failure: failedAt ? { step: failedAt, error: 'boom' } : null }
}

describe('the upstream watch', () => {
  it('emits the latest npm version of every released, upstreamed or failed-at-released package', async () => {
    const store = new InMemoryStore()
    const registry = new FakeRegistry()
    const runs: [string, RunState, RunState?][] = [
      ['released-pkg', 'released'],
      ['upstreamed-pkg', 'upstreamed'],
      ['retrying-pkg', 'failed', 'released'],
      ['approved-pkg', 'failed', 'approved'],
      ['review-pkg', 'in-review'],
      ['superseded-pkg', 'superseded'],
      ['unpublished-pkg', 'released']
    ]
    for (const [name, state, failedAt] of runs) {
      await store.createRunIfAbsent(runOf(name, state, failedAt))
      if (name !== 'unpublished-pkg') {
        registry.publish(name, '1.0.3')
        registry.publish(name, '2.0.0-beta.1')
        registry.tagLatest(name, '1.0.4')
      }
    }
    const events: PipelineEvent[] = []
    const watch = createUpstreamWatch({
      store,
      registry,
      emit: async (event) => {
        events.push(event)
      }
    })

    expect(await watch.check()).toBe(3)
    expect(events).toEqual(
      ['released-pkg', 'retrying-pkg', 'upstreamed-pkg'].map((packageName) => ({
        type: 'upstream-version-published',
        packageName,
        version: '1.0.4'
      }))
    )
  })
})
