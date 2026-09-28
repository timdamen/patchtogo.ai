import type { SecurityAdvisory } from '../../src/advisory.ts'
import type { GitHub } from '../../src/pipeline/ports.ts'

export class InMemoryGitHub implements GitHub {
  readonly advisories = new Map<string, SecurityAdvisory>()

  publishAdvisory(advisory: SecurityAdvisory): void {
    this.advisories.set(advisory.ghsaId, structuredClone(advisory))
  }

  getAdvisory(ghsaId: string): Promise<SecurityAdvisory | undefined> {
    const advisory = this.advisories.get(ghsaId)
    return Promise.resolve(advisory && structuredClone(advisory))
  }
}
