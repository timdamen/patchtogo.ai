import { describe, expect, it } from 'vitest'
import type { SecurityAdvisory } from '../src/advisory.ts'
import { createAdvisoryPoller, InMemoryPollCursor } from '../src/advisory-poller.ts'
import { npmAdvisoriesUpdatedSince, type GitHubApiOptions } from '../src/github-advisories.ts'
import type { PipelineEvent } from '../src/pipeline/events.ts'
import { createTestPipeline } from './fakes/pipeline.ts'

interface ListedAdvisory {
  ghsa_id: string
  updated_at: string
}

function advisoriesApi(advisories: ListedAdvisory[], { pageSize = 2, failOnPage = 0 } = {}) {
  const requests: { url: URL; headers: Headers }[] = []

  const fetchAdvisories: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    requests.push({ url, headers: new Headers(init?.headers) })
    const page = Number(url.searchParams.get('after') ?? 0)
    if (page + 1 === failOnPage) return new Response('boom', { status: 502 })

    const since = new Date((url.searchParams.get('updated') ?? '>=1970-01-01T00:00:00Z').slice(2))
    const matching = advisories
      .filter((a) => new Date(a.updated_at) >= since)
      .toSorted((a, b) => a.updated_at.localeCompare(b.updated_at))
    const start = page * pageSize
    const headers = new Headers()
    if (start + pageSize < matching.length) {
      const next = new URL(url)
      next.searchParams.set('after', String(page + 1))
      headers.set('link', `<${next}>; rel="next"`)
    }
    return Response.json(matching.slice(start, start + pageSize), { headers })
  }

  return { requests, fetch: fetchAdvisories }
}

function poller(api: GitHubApiOptions, since = '2026-09-28T00:00:00Z') {
  const events: PipelineEvent[] = []
  const cursor = new InMemoryPollCursor(new Date(since))
  const advisoryPoller = createAdvisoryPoller({
    updatedSince: (date) => npmAdvisoriesUpdatedSince(date, api),
    cursor,
    emit: async (event) => {
      events.push(event)
    }
  })
  return { events, cursor, poll: () => advisoryPoller.poll() }
}

const listed: ListedAdvisory[] = [
  { ghsa_id: 'GHSA-aaaa-aaaa-aaaa', updated_at: '2026-09-28T01:00:00Z' },
  { ghsa_id: 'GHSA-bbbb-bbbb-bbbb', updated_at: '2026-09-28T02:00:00Z' },
  { ghsa_id: 'GHSA-cccc-cccc-cccc', updated_at: '2026-09-28T03:00:00Z' }
]

describe('advisory poller', () => {
  it('asks GitHub for reviewed, current npm advisories updated since the cursor', async () => {
    const api = advisoriesApi([])

    await poller({ fetch: api.fetch }, '2026-09-28T00:00:00.123Z').poll()

    const [request] = api.requests
    expect(request?.url.origin + (request?.url.pathname ?? '')).toBe(
      'https://api.github.com/advisories'
    )
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      ecosystem: 'npm',
      type: 'reviewed',
      is_withdrawn: 'false',
      updated: '>=2026-09-28T00:00:00Z',
      sort: 'updated',
      direction: 'asc',
      per_page: '100'
    })
    expect(request?.headers.has('authorization')).toBe(false)
  })

  it('sends the token when one is configured', async () => {
    const api = advisoriesApi([])

    await poller({ fetch: api.fetch, token: 'ghs_test' }).poll()

    expect(api.requests[0]?.headers.get('authorization')).toBe('Bearer ghs_test')
  })

  it('pages through the results and emits one event per advisory', async () => {
    const api = advisoriesApi(listed)
    const { events, poll } = poller({ fetch: api.fetch })

    expect(await poll()).toBe(3)

    expect(api.requests).toHaveLength(2)
    expect(events).toEqual(listed.map((a) => ({ type: 'advisory-published', ghsaId: a.ghsa_id })))
  })

  it('resumes the next poll from the latest update it has seen', async () => {
    const api = advisoriesApi(listed)
    const { cursor, poll } = poller({ fetch: api.fetch })

    await poll()
    await poll()

    expect(await cursor.get()).toEqual(new Date('2026-09-28T03:00:00Z'))
    expect(api.requests.at(-1)?.url.searchParams.get('updated')).toBe('>=2026-09-28T03:00:00Z')
  })

  it('keeps the cursor at the last complete page when a later page fails', async () => {
    const api = advisoriesApi(listed, { failOnPage: 2 })
    const { events, cursor, poll } = poller({ fetch: api.fetch })

    await expect(poll()).rejects.toThrow(/HTTP 502/)

    expect(events.map((e) => e.type === 'advisory-published' && e.ghsaId)).toEqual([
      'GHSA-aaaa-aaaa-aaaa',
      'GHSA-bbbb-bbbb-bbbb'
    ])
    expect(await cursor.get()).toEqual(new Date('2026-09-28T02:00:00Z'))
  })

  it('creates no duplicate runs when poll windows overlap', async () => {
    const { pipeline, github, registry, store, model } = createTestPipeline({
      triage: () => ({ decision: 'skip', reason: 'test', suspectedFiles: [], fixStrategy: '' })
    })
    for (const { ghsa_id } of listed) {
      github.publishAdvisory(npmAdvisory(ghsa_id))
      registry.publish(ghsa_id.toLowerCase(), '1.0.0')
    }
    const api = advisoriesApi(listed)
    const advisoryPoller = createAdvisoryPoller({
      updatedSince: (date) => npmAdvisoriesUpdatedSince(date, { fetch: api.fetch }),
      cursor: new InMemoryPollCursor(new Date('2026-09-28T00:00:00Z')),
      emit: (event) => pipeline.handle(event)
    })

    await advisoryPoller.poll()
    const before = await store.listRuns()
    await advisoryPoller.poll()

    expect(before).toHaveLength(3)
    expect(await store.listRuns()).toEqual(before)
    expect(model.doGenerateCalls).toHaveLength(3)
  })

  it('creates no runs for a malware advisory', async () => {
    const { pipeline, github, registry, store, model } = createTestPipeline()
    const [malware] = listed
    github.publishAdvisory({ ...npmAdvisory(malware?.ghsa_id ?? ''), type: 'malware' })
    registry.publish(malware?.ghsa_id.toLowerCase() ?? '', '1.0.0')
    const api = advisoriesApi(listed.slice(0, 1))
    const advisoryPoller = createAdvisoryPoller({
      updatedSince: (date) => npmAdvisoriesUpdatedSince(date, { fetch: api.fetch }),
      cursor: new InMemoryPollCursor(new Date('2026-09-28T00:00:00Z')),
      emit: (event) => pipeline.handle(event)
    })

    await advisoryPoller.poll()

    expect(await store.listRuns()).toEqual([])
    expect(model.doGenerateCalls).toHaveLength(0)
  })
})

function npmAdvisory(ghsaId: string): SecurityAdvisory {
  return {
    ghsaId,
    type: 'reviewed',
    cveId: null,
    summary: 'Prototype Pollution',
    description: '',
    severity: 'high',
    vulnerabilities: [
      {
        ecosystem: 'npm',
        packageName: ghsaId.toLowerCase(),
        vulnerableRange: '<= 1.0.0',
        patchedVersion: null
      }
    ]
  }
}
