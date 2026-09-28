import semver from 'semver'
import type { RepoRef } from './pipeline/ports.ts'

export function latestVulnerableVersion(
  versions: string[],
  vulnerableRange: string
): string | undefined {
  const range = semver.validRange(vulnerableRange.replaceAll(',', ' '))
  if (range === null) return undefined
  return semver.maxSatisfying(versions, range) ?? undefined
}

const ownerPattern = '([\\w.-]+)'
const repoPattern = '([\\w.-]+?)'

const repositoryPatterns = [
  new RegExp(`^github:${ownerPattern}/${repoPattern}(?:\\.git)?(?:#.*)?$`, 'i'),
  new RegExp(`^${ownerPattern}/${repoPattern}(?:\\.git)?(?:#.*)?$`),
  new RegExp(
    `^(?:git\\+)?(?:https?|git|ssh)://(?:[^@/]+@)?(?:www\\.)?github\\.com[:/]${ownerPattern}/${repoPattern}(?:\\.git)?(?:[/#?].*)?$`,
    'i'
  ),
  new RegExp(`^(?:[^@/]+@)?github\\.com:${ownerPattern}/${repoPattern}(?:\\.git)?(?:#.*)?$`, 'i')
]

export function githubRepository(url: string): RepoRef | undefined {
  for (const pattern of repositoryPatterns) {
    const match = pattern.exec(url.trim())
    if (match?.[1] && match[2]) return { owner: match[1], repo: match[2] }
  }
  return undefined
}

export function releaseRefs(packageName: string, version: string): string[] {
  const unscoped = packageName.replace(/^@[^/]+\//, '')
  return [
    ...new Set([
      `v${version}`,
      version,
      `${packageName}@${version}`,
      `${unscoped}@${version}`,
      `${unscoped}-v${version}`
    ])
  ]
}

export function repoName({ owner, repo }: RepoRef): string {
  return `${owner}/${repo}`
}
