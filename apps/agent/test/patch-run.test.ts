import { describe, expect, it } from 'vitest'
import type { Advisory } from '../src/advisory.ts'
import { IllegalTransitionError, newPatchRun, transition } from '../src/pipeline/patch-run.ts'

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
  it('rejects an illegal transition', () => {
    const run = newPatchRun(advisory, new Date(0))

    expect(() => transition(run, { to: 'forking' }, new Date(1))).toThrow(IllegalTransitionError)
  })
})
