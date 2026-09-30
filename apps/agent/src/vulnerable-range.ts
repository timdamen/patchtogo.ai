import semver from 'semver'

export interface VulnerableRange {
  includes(version: string): boolean
  latest(versions: string[]): string | undefined
}

const options = { includePrerelease: true }
const comparatorPattern = /^(<=|>=|<|>|=)\s*(\S+)$/
const partialVersionPattern = /^\d+(?:\.\d+)?$/

function fullVersion(text: string): string | undefined {
  const padded = partialVersionPattern.test(text)
    ? [...text.split('.'), '0', '0'].slice(0, 3).join('.')
    : text
  return semver.valid(padded) ?? undefined
}

export function parseVulnerableRange(text: string): VulnerableRange | undefined {
  const comparators: string[] = []
  for (const part of text.split(',')) {
    const match = comparatorPattern.exec(part.trim())
    const version = match?.[2] ? fullVersion(match[2]) : undefined
    if (!match || !version) return undefined
    comparators.push(`${match[1]}${version}`)
  }
  const range = new semver.Range(comparators.join(' '), options)
  return {
    includes: (version) => semver.satisfies(version, range, options),
    latest(versions) {
      const stable = versions.filter((version) => !semver.prerelease(version))
      return (
        semver.maxSatisfying(stable, range, options) ??
        semver.maxSatisfying(versions, range, options) ??
        undefined
      )
    }
  }
}
