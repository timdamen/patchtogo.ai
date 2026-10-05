import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWatchedAdvisories, toNpmAdvisories } from '../src/github-advisories.ts'

const raw = {
  ghsa_id: 'GHSA-p6mc-m468-83gw',
  cve_id: 'CVE-2020-8203',
  summary: 'Prototype Pollution in lodash',
  description: 'details',
  severity: 'medium',
  vulnerabilities: [
    {
      package: { ecosystem: 'npm', name: 'lodash' },
      vulnerable_version_range: '>= 3.7.0, < 4.17.19',
      first_patched_version: '4.17.19'
    },
    {
      package: { ecosystem: 'npm', name: 'lodash.set' },
      vulnerable_version_range: '>= 3.7.0, <= 4.3.2',
      first_patched_version: null
    },
    {
      package: { ecosystem: 'rubygems', name: 'lodash-rails' },
      vulnerable_version_range: '>= 3.7.0, < 4.17.19',
      first_patched_version: '4.17.19'
    }
  ]
}

describe('toNpmAdvisories', () => {
  it('keeps one entry per npm package and normalises severity', () => {
    const advisories = toNpmAdvisories(raw)

    expect(advisories.map((a) => a.packageName)).toEqual(['lodash', 'lodash.set'])
    expect(advisories[1]).toMatchObject({ patchedVersion: null, severity: 'moderate' })
  })

  it('drops advisories without a known severity', () => {
    expect(toNpmAdvisories({ ...raw, severity: 'unknown' })).toEqual([])
  })
})

describe('fetchWatchedAdvisories', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks GitHub for the package and keeps only its entries', async () => {
    const fetchMock = vi.fn(async (_url: string) => Response.json([raw]))
    vi.stubGlobal('fetch', fetchMock)

    const advisories = await fetchWatchedAdvisories('lodash.set')

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('affects=lodash.set')
    expect(advisories.map((a) => a.packageName)).toEqual(['lodash.set'])
  })

  it('throws on a failed request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    )

    await expect(fetchWatchedAdvisories('zod')).rejects.toThrow('HTTP 503')
  })
})
