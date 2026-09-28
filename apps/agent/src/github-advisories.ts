import { z } from 'zod'
import type { SecurityAdvisory } from './advisory.ts'

const globalAdvisorySchema = z.object({
  ghsa_id: z.string(),
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

export function parseGlobalAdvisory(raw: unknown): SecurityAdvisory {
  const advisory = globalAdvisorySchema.parse(raw)
  return {
    ghsaId: advisory.ghsa_id,
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

export async function fetchGlobalAdvisory(ghsaId: string): Promise<SecurityAdvisory | undefined> {
  const response = await fetch(`https://api.github.com/advisories/${encodeURIComponent(ghsaId)}`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`GitHub advisory ${ghsaId}: HTTP ${response.status}`)
  return parseGlobalAdvisory(await response.json())
}
