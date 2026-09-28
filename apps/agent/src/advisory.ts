import { z } from 'zod'

export const advisorySchema = z.object({
  ghsaId: z.string(),
  cveId: z.string().nullable(),
  packageName: z.string(),
  vulnerableRange: z.string(),
  patchedVersion: z.string().nullable(),
  severity: z.enum(['low', 'moderate', 'high', 'critical']),
  summary: z.string(),
  description: z.string()
})

export type Advisory = z.infer<typeof advisorySchema>

export interface Vulnerability {
  ecosystem: string
  packageName: string
  vulnerableRange: string | null
  patchedVersion: string | null
}

export interface SecurityAdvisory {
  ghsaId: string
  cveId: string | null
  summary: string
  description: string
  severity: Advisory['severity'] | 'unknown'
  vulnerabilities: Vulnerability[]
}

export function npmAdvisories(advisory: SecurityAdvisory): Advisory[] {
  const { severity } = advisory
  if (severity === 'unknown') return []

  return advisory.vulnerabilities
    .filter((v) => v.ecosystem === 'npm')
    .map((v) => ({
      ghsaId: advisory.ghsaId,
      cveId: advisory.cveId,
      packageName: v.packageName,
      vulnerableRange: v.vulnerableRange ?? '*',
      patchedVersion: v.patchedVersion,
      severity,
      summary: advisory.summary,
      description: advisory.description
    }))
}
