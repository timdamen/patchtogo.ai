import { z } from 'zod'
import { advisoryTypes, type SecurityAdvisory } from './advisory.ts'

export interface GitHubApiOptions {
  token?: string
  fetch?: typeof fetch
}

export interface AdvisoryUpdate {
  ghsaId: string
  updatedAt: Date
}

const apiUrl = 'https://api.github.com'

const globalAdvisorySchema = z.object({
  ghsa_id: z.string(),
  type: z.enum(advisoryTypes),
  cve_id: z.string().nullable(),
  summary: z.string(),
  description: z.string().nullable(),
  severity: z.enum(['low', 'medium', 'moderate', 'high', 'critical', 'unknown']),
  vulnerabilities: z.array(
    z.object({
      package: z.object({ ecosystem: z.string(), name: z.string() }),
      vulnerable_version_range: z.string().nullable(),
      first_patched_version: z.string().nullable()
    })
  )
})

const advisoryListSchema = z.array(
  z.object({ ghsa_id: z.string(), updated_at: z.iso.datetime({ offset: true }) })
)

export function parseGlobalAdvisory(raw: unknown): SecurityAdvisory {
  const advisory = globalAdvisorySchema.parse(raw)
  return {
    ghsaId: advisory.ghsa_id,
    type: advisory.type,
    cveId: advisory.cve_id,
    summary: advisory.summary,
    description: advisory.description ?? '',
    severity: advisory.severity === 'medium' ? 'moderate' : advisory.severity,
    vulnerabilities: advisory.vulnerabilities.map((v) => ({
      ecosystem: v.package.ecosystem,
      packageName: v.package.name,
      vulnerableRange: v.vulnerable_version_range,
      patchedVersion: v.first_patched_version
    }))
  }
}

function get(url: string, { token, fetch: fetchImpl = fetch }: GitHubApiOptions) {
  return fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  })
}

export async function fetchGlobalAdvisory(
  ghsaId: string,
  options: GitHubApiOptions = {}
): Promise<SecurityAdvisory | undefined> {
  const response = await get(`${apiUrl}/advisories/${encodeURIComponent(ghsaId)}`, options)
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`GitHub advisory ${ghsaId}: HTTP ${response.status}`)
  return parseGlobalAdvisory(await response.json())
}

function searchTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function nextPage(link: string | null): string | undefined {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1]
}

export async function* npmAdvisoriesUpdatedSince(
  since: Date,
  options: GitHubApiOptions = {}
): AsyncGenerator<AdvisoryUpdate[]> {
  const query = new URLSearchParams({
    ecosystem: 'npm',
    type: 'reviewed',
    is_withdrawn: 'false',
    updated: `>=${searchTimestamp(since)}`,
    sort: 'updated',
    direction: 'asc',
    per_page: '100'
  })
  let url: string | undefined = `${apiUrl}/advisories?${query}`
  while (url) {
    const response = await get(url, options)
    if (!response.ok) throw new Error(`GitHub advisories: HTTP ${response.status}`)
    const page = advisoryListSchema.parse(await response.json())
    yield page.map((a) => ({ ghsaId: a.ghsa_id, updatedAt: new Date(a.updated_at) }))
    url = nextPage(response.headers.get('link'))
  }
}
