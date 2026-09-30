import type { Advisory } from './advisory.ts'
import { code, fenced } from './patch-pr.ts'
import type { AffectedVersions, NewRepositoryAdvisory } from './pipeline/ports.ts'

const severities = {
  low: 'low',
  moderate: 'medium',
  high: 'high',
  critical: 'critical'
} as const satisfies Record<Advisory['severity'], NewRepositoryAdvisory['severity']>

export function upstreamAdvisoryUrl(ghsaId: string): string {
  return `https://github.com/advisories/${encodeURIComponent(ghsaId)}`
}

export function upstreamAdvisoryLine(ghsaId: string): string {
  return `Upstream advisory: ${upstreamAdvisoryUrl(ghsaId)}`
}

export function repositoryAdvisory(
  advisory: Advisory,
  patchedName: string,
  vulnerabilities: AffectedVersions[]
): NewRepositoryAdvisory {
  const { ghsaId, cveId, packageName, vulnerableRange } = advisory
  return {
    summary: `${ghsaId} in ${packageName} also affects ${patchedName}`,
    description: [
      `${code(patchedName)} is patchtogo's patched fork of the npm package ${code(packageName)}. Its releases are built from a version of ${code(packageName)} that the upstream advisory lists as vulnerable (${code(vulnerableRange)}), so they are affected too. The affected ${code(patchedName)} versions are listed in this advisory.`,
      '',
      upstreamAdvisoryLine(ghsaId),
      ...(cveId ? [`Upstream CVE: ${cveId}`] : []),
      '',
      `patchtogo works on a follow-up release that keeps its earlier fixes. Once that release is published, this advisory names it as the patched version. Until then, or if the vulnerability cannot be patched, there is no patched version: switch back to ${code(packageName)} if an upstream release fixes both this and the earlier advisories.`,
      '',
      'The upstream summary, verbatim:',
      '',
      fenced(advisory.summary)
    ].join('\n'),
    severity: severities[advisory.severity],
    vulnerabilities
  }
}
