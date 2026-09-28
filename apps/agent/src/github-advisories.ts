import { z } from 'zod'
import type { Advisory } from './advisory.ts'

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

export function toNpmAdvisories(raw: unknown): Advisory[] {
  const advisory = globalAdvisorySchema.parse(raw)
  const severity = advisory.severity === 'medium' ? 'moderate' : advisory.severity
  if (severity === 'unknown') return []

  return advisory.vulnerabilities
    .filter((v) => v.package.ecosystem === 'npm')
    .map((v) => ({
      ghsaId: advisory.ghsa_id,
      cveId: advisory.cve_id,
      packageName: v.package.name,
      vulnerableRange: v.vulnerable_version_range ?? '*',
      patchedVersion: v.first_patched_version,
      severity,
      summary: advisory.summary,
      description: advisory.description ?? ''
    }))
}

export async function fetchNpmAdvisories(ghsaId: string): Promise<Advisory[]> {
  const response = await fetch(`https://api.github.com/advisories/${encodeURIComponent(ghsaId)}`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
  })
  if (!response.ok) throw new Error(`GitHub advisory ${ghsaId}: HTTP ${response.status}`)
  return toNpmAdvisories(await response.json())
}
