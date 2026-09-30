import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { injectTestAdvisory } from '../src/operator.ts'
import type { PipelineEvent } from '../src/pipeline/events.ts'
import {
  advisory,
  fixResult,
  patchBranch as realPatchBranch,
  releasePatchPr,
  setupPatchRun
} from './fakes/escape-html-fix.ts'
import { stores } from './support/stores.ts'

const testAdvisory = JSON.parse(
  await readFile(new URL('../test-advisories/escape-html-backtick.json', import.meta.url), 'utf8')
) as { ghsa_id: string; vulnerabilities: { package: { name: string } }[] }
const testGhsa = testAdvisory.ghsa_id
const testRunId = `${testGhsa}:escape-html`
const testPatchBranch = realPatchBranch.replace(/ghsa-[^/]+$/, testGhsa.toLowerCase())

describe.each(stores)('test advisories on the %s store', (_name, createStore) => {
  async function setup() {
    const test = await setupPatchRun(await createStore(), [fixResult()], 'full', {
      upstreamAccount: true
    })
    test.registry.publish('@patchtogo.ai/escape-html', '0.0.0-ptg.0')
    const sent: PipelineEvent[] = []
    const queue = {
      async send(event: PipelineEvent) {
        sent.push(event)
        await test.pipeline.handle(event)
      }
    }
    const inject = (raw: unknown, allowed = ['escape-html']) =>
      injectTestAdvisory(raw, allowed, { store: test.store, queue })
    const run = () => test.store.getRun(testRunId)
    return { ...test, sent, inject, run }
  }

  it('drives a patch run from an injected test advisory and marks its pull request as a test', async () => {
    const test = await setup()

    expect(await test.inject(testAdvisory)).toBe(testGhsa)

    expect(await test.run()).toMatchObject({ state: 'in-review' })
    expect(test.fixer.requests.map((request) => request.advisory.ghsaId)).toEqual([testGhsa])
    const [pullRequest] = test.github.pullRequests
    expect(pullRequest?.title).toBe(`[patchtogo test] fix: close ${testGhsa} in escape-html@1.0.3`)
    expect(pullRequest?.body).toMatch(/^> \[!WARNING\]\n> \*\*patchtogo test\.\*\* /)
    expect(pullRequest?.body).not.toContain(`github.com/advisories/${testGhsa}`)
  })

  const notTestId = 'is not a test advisory ID'
  const notListed = 'escape-html is not in PTG_AUTOMATION_PACKAGES'

  it.each([
    [
      'a real advisory ID',
      { ...testAdvisory, ghsa_id: 'GHSA-gxr4-xjj5-5px2' },
      ['escape-html'],
      notTestId
    ],
    [
      'a malformed test ID',
      { ...testAdvisory, ghsa_id: 'GHSA-ptg0-dry0' },
      ['escape-html'],
      notTestId
    ],
    ['a package missing from the allowlist', testAdvisory, ['html-escaper'], notListed],
    ['an empty allowlist', testAdvisory, [], notListed]
  ])('refuses %s and stores nothing', async (_case, raw, allowed, message) => {
    const test = await setup()

    await expect(test.inject(raw, allowed)).rejects.toThrow(message)

    expect(await test.store.getTestAdvisory(raw.ghsa_id)).toBeUndefined()
    expect(test.sent).toEqual([])
    expect(await test.store.listRuns()).toEqual([])
  })

  it('never takes a test advisory from GitHub', async () => {
    const test = await setup()
    test.github.publishAdvisory({ ...advisory, ghsaId: testGhsa })

    await test.pipeline.handle({ type: 'advisory-published', ghsaId: testGhsa })

    expect(await test.store.listRuns()).toEqual([])
  })

  it('releases a merged test run with a reminder to deprecate it and never proposes it upstream', async () => {
    const test = await setup()
    await test.inject(testAdvisory)

    await releasePatchPr(test, 1, testPatchBranch, '1.0.3-ptg.1')

    const released = await test.run()
    expect(released).toMatchObject({ state: 'released', stable: { version: '1.0.3-ptg.1' } })
    expect(released?.upstream?.blocked).toContain(`${testGhsa} is a patchtogo test advisory`)
    expect(test.github.pullRequests.map((pr) => pr.repo)).toEqual(['patchtogo-ai/escape-html'])
    expect(test.notifier.notifications.at(-1)).toMatchObject({ type: 'upstream-pr-blocked' })
    const events = await test.store.listEvents(testRunId)
    expect(events.find((event) => event.state === 'released')?.reason).toContain(
      "npm deprecate '@patchtogo.ai/escape-html@1.0.3-ptg.1' 'patchtogo test release, not a security fix'"
    )
  })
})
