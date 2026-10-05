import { npmAdvisories, type SecurityAdvisory } from './advisory.ts'
import { parseGlobalAdvisory } from './github-advisories.ts'
import type { GitHub } from './pipeline/ports.ts'

export const TEST_ADVISORY_PREFIX = 'GHSA-ptg0-'

export const TEST_MARK = '[patchtogo test]'

const testAdvisoryId = /^GHSA-ptg0-[0-9a-z]{4}-[0-9a-z]{4}$/

export interface TestAdvisories {
  getTestAdvisory(ghsaId: string): Promise<SecurityAdvisory | undefined>
}

export function isTestAdvisory(ghsaId: string): boolean {
  return ghsaId.startsWith(TEST_ADVISORY_PREFIX)
}

export function testMarked(text: string, ghsaId: string): string {
  return isTestAdvisory(ghsaId) ? `${TEST_MARK} ${text}` : text
}

export function parseTestAdvisory(
  raw: unknown,
  allowedPackages: readonly string[]
): SecurityAdvisory {
  const advisory = parseGlobalAdvisory(raw)
  if (!testAdvisoryId.test(advisory.ghsaId)) {
    throw new Error(
      `${advisory.ghsaId} is not a test advisory ID: test advisories use ${TEST_ADVISORY_PREFIX}xxxx-xxxx (lowercase letters and digits), which no GitHub advisory can have`
    )
  }
  const packages = npmAdvisories(advisory).map((entry) => entry.packageName)
  if (packages.length === 0) {
    throw new Error(`${advisory.ghsaId} names no npm package that a patch run could be made for`)
  }
  const refused = packages.filter((name) => !allowedPackages.includes(name))
  if (refused.length > 0) {
    throw new Error(
      `${refused.join(', ')} ${refused.length === 1 ? 'is' : 'are'} not in PTG_AUTOMATION_PACKAGES, and test advisories are only accepted for packages listed there`
    )
  }
  return advisory
}

export function withTestAdvisories(github: GitHub, advisories: TestAdvisories): GitHub {
  async function getAdvisory(ghsaId: string): Promise<SecurityAdvisory | undefined> {
    return isTestAdvisory(ghsaId) ? advisories.getTestAdvisory(ghsaId) : github.getAdvisory(ghsaId)
  }
  return new Proxy(github, {
    get(target, property) {
      if (property === 'getAdvisory') return getAdvisory
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
