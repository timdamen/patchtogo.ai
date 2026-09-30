import { describe, expect, it } from 'vitest'
import { listFailures, requestRetry } from '../src/operator.ts'
import {
  advisory,
  fixResult,
  ghsaId,
  runId as listedRunId,
  setupPatchRun
} from './fakes/escape-html-fix.ts'
import { inlineQueue } from './fakes/pipeline.ts'
import { seedUpstream } from './fakes/upstream.ts'
import { stores } from './support/stores.ts'

const unlistedRunId = `${ghsaId}:html-escaper`

describe.each(stores)('the automation allowlist on the %s store', (_name, createStore) => {
  async function setup() {
    const test = await setupPatchRun(await createStore(), [fixResult(), fixResult()])
    seedUpstream(test.github, test.registry, { name: 'html-escaper', version: '1.0.3' })
    test.github.publishAdvisory({
      ...advisory,
      vulnerabilities: [
        ...advisory.vulnerabilities,
        {
          ecosystem: 'npm',
          packageName: 'html-escaper',
          vulnerableRange: '<= 1.0.3',
          patchedVersion: null
        }
      ]
    })
    const allowlisted = test.withAutomation('full', ['escape-html'])
    await allowlisted.handle({ type: 'advisory-published', ghsaId })
    return test
  }

  it('holds an unlisted package after triage at full automation while a listed one runs through', async () => {
    const test = await setup()

    expect(await test.store.getRun(listedRunId)).toMatchObject({ state: 'in-review' })
    const held = await test.store.getRun(unlistedRunId)
    expect(held).toMatchObject({
      state: 'triaged',
      triage: { decision: 'patch' },
      held: { action: 'forking', needs: 'fork' }
    })
    expect(held?.reason).toContain(
      'html-escaper is not in PTG_AUTOMATION_PACKAGES, so it stays at triage-only'
    )
    expect(test.github.forks().map((fork) => fork.ref.repo)).toEqual(['escape-html'])
    expect(test.fixer.requests.map((request) => request.runId)).toEqual([listedRunId])
    const { held: listed } = await listFailures({
      store: test.store,
      queue: inlineQueue(test.pipeline)
    })
    expect(listed.map((run) => run.id)).toEqual([unlistedRunId])
  })

  it('resumes the held run when the operator retries it after listing the package', async () => {
    const test = await setup()
    const widened = test.withAutomation('full', ['escape-html', 'html-escaper'])

    const report = await requestRetry(unlistedRunId, {
      store: test.store,
      queue: inlineQueue(widened)
    })

    expect(report.retriedRuns).toEqual([unlistedRunId])
    const resumed = await test.store.getRun(unlistedRunId)
    expect(resumed).toMatchObject({ state: 'in-review' })
    expect(resumed?.held).toBeUndefined()
    expect(test.github.forks().map((fork) => fork.ref.repo)).toEqual([
      'escape-html',
      'html-escaper'
    ])
  })
})
