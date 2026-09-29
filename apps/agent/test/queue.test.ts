import { fromPglite, PgBoss } from 'pg-boss'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { listFailures, requestRetry } from '../src/operator.ts'
import type { PipelineEvent } from '../src/pipeline/events.ts'
import { PostgresStore } from '../src/postgres/store.ts'
import { createPipelineQueue, type PipelineQueueOptions } from '../src/queue.ts'
import type { Triage } from '../src/triage.ts'
import { createTestPipeline } from './fakes/pipeline.ts'
import { seedUpstream } from './fakes/upstream.ts'
import { freshDatabase } from './support/stores.ts'

const waitLong = { timeout: 15_000, interval: 50 }

async function startQueue(options: Partial<PipelineQueueOptions> = {}) {
  const database = await freshDatabase()
  const boss = new PgBoss({
    db: fromPglite(database.pglite),
    backend: 'pglite',
    supervise: false,
    schedule: false
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
    const { queue } = await startQueue({ concurrency: 3 })
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

    const events: PipelineEvent[] = [
      published('GHSA-p6mc-m468-83gw'),
      { type: 'retry-requested', runId: 'GHSA-p6mc-m468-83gw:lodash.set' },
      published('GHSA-p6mc-m468-83gw')
    ]
    for (const event of events) await queue.send(event)

    await vi.waitFor(() => expect(handled).toHaveLength(3), waitLong)
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
      cveId: null,
      summary: 'Prototype Pollution',
      description: 'untrusted',
      severity: 'high',
      vulnerabilities: [
        { ecosystem: 'npm', packageName: 'lodash.set', vulnerableRange: '*', patchedVersion: null }
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
      cveId: null,
      summary: 'Prototype Pollution',
      description: 'untrusted',
      severity: 'high',
      vulnerabilities: [
        { ecosystem: 'npm', packageName: 'lodash.set', vulnerableRange: '*', patchedVersion: null }
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

  it('does nothing for a run that has not failed and refuses unknown runs', async () => {
    const { queue, db } = await startQueue()
    const store = new PostgresStore(db)

    await expect(requestRetry('GHSA-p6mc-m468-83gw:lodash.set', { store, queue })).rejects.toThrow(
      /no patch run/
    )
    expect(await requestRetry('GHSA-p6mc-m468-83gw', { store, queue })).toEqual({
      retriedJobs: 0,
      retriedRuns: []
    })
  })
})
