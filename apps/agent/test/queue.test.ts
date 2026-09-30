import { fromPglite, PgBoss, TestClock } from 'pg-boss'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { listFailures, requestRetry } from '../src/operator.ts'
import type { PipelineEvent } from '../src/pipeline/events.ts'
import { newPatchRun } from '../src/pipeline/patch-run.ts'
import { PostgresStore } from '../src/postgres/store.ts'
import { createPipelineQueue, type PipelineQueueOptions } from '../src/queue.ts'
import type { Triage } from '../src/triage.ts'
import { createTestPipeline } from './fakes/pipeline.ts'
import { seedUpstream } from './fakes/upstream.ts'
import { freshDatabase } from './support/stores.ts'

const waitLong = { timeout: 15_000, interval: 50 }

async function startQueue(options: Partial<PipelineQueueOptions> = {}, clock?: TestClock) {
  const database = await freshDatabase()
  const boss = new PgBoss({
    db: fromPglite(database.pglite),
    backend: 'pglite',
    supervise: false,
    schedule: false,
    clock
  })
  boss.on('error', (error) => {
    throw error
  })
  await boss.start()
  onTestFinished(() => boss.stop({ graceful: false, close: false }))
  const queue = await createPipelineQueue(boss, {
    concurrency: 2,
    timeoutSeconds: 3600,
    retryLimit: 0,
    retryDelaySeconds: 0,
    pollingIntervalSeconds: 0.5,
    ...options
  })
  return { ...database, queue }
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

const published = (ghsaId: string): PipelineEvent => ({ type: 'advisory-published', ghsaId })

describe('the pipeline queue', { timeout: 30_000 }, () => {
  it('never runs more events at once than the concurrency limit', async () => {
    const { queue } = await startQueue({ concurrency: 2 })
    const release = gate()
    const handled: string[] = []
    let active = 0
    let peak = 0
    await queue.work(async (event) => {
      active++
      peak = Math.max(peak, active)
      await release.opened
      if (event.type === 'advisory-published') handled.push(event.ghsaId)
      active--
    })

    for (const n of [1, 2, 3, 4, 5]) await queue.send(published(`GHSA-000${n}`))
    await vi.waitFor(() => expect(active).toBe(2), waitLong)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(active).toBe(2)
    release.open()

    await vi.waitFor(() => expect(handled).toHaveLength(5), waitLong)
    expect(peak).toBe(2)
  })

  it('handles the events of one advisory one at a time, in order', async () => {
    const clock = new TestClock()
    const { queue } = await startQueue({ concurrency: 3 }, clock)
    const handled: PipelineEvent[] = []
    let active = 0
    let peak = 0
    await queue.work(async (event) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 100))
      handled.push(event)
      active--
    })

    const events: PipelineEvent[] = [1, 2, 3, 4].flatMap((n): PipelineEvent[] => [
      published('GHSA-p6mc-m468-83gw'),
      { type: 'retry-requested', runId: `GHSA-p6mc-m468-83gw:package-${n}` },
      {
        type: 'pull-request-commented',
        pullRequest: {
          repository: { owner: 'patchtogo-ai', repo: `package-${n}` },
          number: 1,
          head: `ptg/patch/package-${n}/1.0.0/ghsa-p6mc-m468-83gw`
        },
        comment: {
          id: n,
          author: { login: 'alice', bot: false },
          body: 'Please escape > too.',
          url: `https://github.com/patchtogo-ai/package-${n}/pull/1#issuecomment-${n}`
        }
      }
    ])
    for (const event of events) await queue.send(event)

    await vi.waitFor(async () => {
      await clock.tick(500)
      expect(handled).toHaveLength(events.length)
    }, waitLong)
    expect(handled).toEqual(events)
    expect(peak).toBe(1)
  })

  it('holds an advisory whose event failed until the operator retries it', async () => {
    const { queue, db } = await startQueue()
    const store = new PostgresStore(db)
    let githubDown = true
    const handled: PipelineEvent[] = []
    await queue.work(async (event) => {
      if (event.type === 'advisory-published' && event.ghsaId === 'GHSA-aaaa' && githubDown) {
        throw new Error('GitHub is down')
      }
      handled.push(event)
    })

    await queue.send(published('GHSA-aaaa'))
    await vi.waitFor(async () => expect(await queue.failedKeys()).toEqual(['GHSA-aaaa']), waitLong)
    await queue.send(published('GHSA-aaaa'))
    await queue.send(published('GHSA-bbbb'))
    await vi.waitFor(() => expect(handled).toEqual([published('GHSA-bbbb')]), waitLong)
    expect(await listFailures({ store, queue })).toEqual({
      runs: [],
      held: [],
      blockedAdvisories: ['GHSA-aaaa']
    })

    githubDown = false
    expect(await requestRetry('GHSA-aaaa', { store, queue })).toEqual({
      retriedJobs: 1,
      retriedRuns: []
    })

    await vi.waitFor(() => expect(handled).toHaveLength(3), waitLong)
    expect(handled.slice(1)).toEqual([published('GHSA-aaaa'), published('GHSA-aaaa')])
    expect(await queue.failedKeys()).toEqual([])
  })
})

describe('operator retry', { timeout: 30_000 }, () => {
  const patch: Triage = {
    decision: 'patch',
    reason: 'a key guard fixes it',
    suspectedFiles: ['index.js'],
    fixStrategy: 'reject __proto__'
  }

  it('resumes a failed run from its failed step through the queue', async () => {
    const { queue, db } = await startQueue()
    let modelDown = true
    const { pipeline, github, registry, store } = createTestPipeline({
      store: new PostgresStore(db),
      triage: () => {
        if (modelDown) throw new Error('model unavailable')
        return patch
      }
    })
    seedUpstream(github, registry, { name: 'lodash.set', version: '4.3.2' })
    github.publishAdvisory({
      ghsaId: 'GHSA-p6mc-m468-83gw',
      type: 'reviewed',
      cveId: null,
      summary: 'Prototype Pollution',
      description: 'untrusted',
      severity: 'high',
      vulnerabilities: [
        {
          ecosystem: 'npm',
          packageName: 'lodash.set',
          vulnerableRange: '<= 4.3.2',
          patchedVersion: null
        }
      ]
    })
    await queue.work((event) => pipeline.handle(event))
    const runId = 'GHSA-p6mc-m468-83gw:lodash.set'

    await queue.send(published('GHSA-p6mc-m468-83gw'))
    await vi.waitFor(
      async () => expect((await store.getRun(runId))?.state).toBe('failed'),
      waitLong
    )
    expect((await listFailures({ store, queue })).runs.map((run) => run.id)).toEqual([runId])

    modelDown = false
    expect(await requestRetry(runId, { store, queue })).toEqual({
      retriedJobs: 0,
      retriedRuns: [runId]
    })

    await vi.waitFor(
      async () =>
        expect(await store.getRun(runId)).toMatchObject({ state: 'fixing', triage: patch }),
      waitLong
    )
  })

  it('resumes runs held by the automation level once the operator retries them', async () => {
    const { queue, db } = await startQueue()
    const store = new PostgresStore(db)
    const held = createTestPipeline({ store, triage: () => patch, automation: 'triage-only' })
    seedUpstream(held.github, held.registry, { name: 'lodash.set', version: '4.3.2' })
    held.github.publishAdvisory({
      ghsaId: 'GHSA-p6mc-m468-83gw',
      type: 'reviewed',
      cveId: null,
      summary: 'Prototype Pollution',
      description: 'untrusted',
      severity: 'high',
      vulnerabilities: [
        {
          ecosystem: 'npm',
          packageName: 'lodash.set',
          vulnerableRange: '<= 4.3.2',
          patchedVersion: null
        }
      ]
    })
    const runId = 'GHSA-p6mc-m468-83gw:lodash.set'
    await held.pipeline.handle(published('GHSA-p6mc-m468-83gw'))
    expect((await store.getRun(runId))?.state).toBe('triaged')
    const forking = held.withAutomation('fork')
    await queue.work((event) => forking.handle(event))

    expect(await requestRetry('GHSA-p6mc-m468-83gw', { store, queue })).toEqual({
      retriedJobs: 0,
      retriedRuns: [runId]
    })

    await vi.waitFor(
      async () => expect((await store.getRun(runId))?.state).toBe('fixing'),
      waitLong
    )
    expect(await requestRetry(runId, { store, queue })).toEqual({
      retriedJobs: 0,
      retriedRuns: [runId]
    })
  })

  it('does nothing for a run it cannot resume and refuses unknown runs', async () => {
    const { queue, db } = await startQueue()
    const store = new PostgresStore(db)
    const handled: PipelineEvent[] = []
    await queue.work(async (event) => {
      handled.push(event)
    })
    const run = newPatchRun(
      {
        ghsaId: 'GHSA-p6mc-m468-83gw',
        cveId: null,
        packageName: 'lodash.set',
        vulnerableRange: '<= 4.3.2',
        patchedVersion: null,
        severity: 'high',
        summary: 'Prototype Pollution',
        description: 'untrusted'
      },
      new Date('2026-09-28T10:00:00Z')
    )
    await store.createRunIfAbsent(run)
    const nothing = { retriedJobs: 0, retriedRuns: [] }

    expect(await requestRetry(run.id, { store, queue })).toEqual(nothing)
    expect(await requestRetry(run.ghsaId, { store, queue })).toEqual(nothing)
    await expect(
      requestRetry('GHSA-p6mc-m468-83gw:lodash.setwith', { store, queue })
    ).rejects.toThrow(/no patch run/)

    await queue.send(published(run.ghsaId))
    await vi.waitFor(() => expect(handled).toEqual([published(run.ghsaId)]), waitLong)
  })
})
