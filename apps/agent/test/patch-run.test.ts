import { describe, expect, it } from 'vitest'
import type { Advisory } from '../src/advisory.ts'
import {
  canTransition,
  IllegalTransitionError,
  isTerminal,
  newPatchRun,
  runStates,
  transition,
  type RunState
} from '../src/pipeline/patch-run.ts'

const specTable: Record<string, RunState[]> = {
  detected: ['triaged'],
  triaged: ['skipped', 'needs-human', 'forking'],
  forking: ['verifying', 'needs-human'],
  verifying: ['fixing', 'needs-human'],
  fixing: ['in-review', 'needs-human'],
  'in-review': ['in-review', 'approved', 'needs-human'],
  approved: ['released'],
  released: ['upstreamed', 'superseded'],
  upstreamed: ['superseded']
}

const advisory: Advisory = {
  ghsaId: 'GHSA-p6mc-m468-83gw',
  cveId: null,
  packageName: 'lodash.set',
  vulnerableRange: '<= 4.3.2',
  patchedVersion: null,
  severity: 'high',
  summary: 's',
  description: 'd'
}

describe('patch run state machine', () => {
  it('has every state from the spec plus the terminal and failed states', () => {
    expect([...runStates].toSorted()).toEqual(
      [
        ...new Set([...Object.keys(specTable), ...Object.values(specTable).flat(), 'failed'])
      ].toSorted()
    )
    expect(runStates.filter(isTerminal).toSorted()).toEqual([
      'needs-human',
      'skipped',
      'superseded'
    ])
  })

  it('allows exactly the transitions in the spec table and a failed exit from non-terminal states', () => {
    for (const from of runStates) {
      for (const to of runStates) {
        const expected =
          to === 'failed'
            ? from !== 'failed' && !isTerminal(from)
            : (specTable[from] ?? []).includes(to)
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected)
      }
    }
  })

  it('rejects an illegal transition', () => {
    const run = newPatchRun(advisory, new Date(0))

    expect(() => transition(run, { to: 'forking' }, new Date(1))).toThrow(IllegalTransitionError)
  })

  it('records the step a run failed in', () => {
    const run = newPatchRun(advisory, new Date(0))

    expect(transition(run, { to: 'failed', reason: 'boom' }, new Date(1))).toMatchObject({
      state: 'failed',
      failure: { step: 'detected', error: 'boom' },
      version: 1
    })
  })
})
