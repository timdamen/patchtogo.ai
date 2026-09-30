import semver from 'semver'
import { npmAdvisories, type Advisory } from '../advisory.ts'
import { patchedPackageName, patchedVersion, type NamingSettings } from '../naming.ts'
import { repositoryAdvisory, upstreamAdvisoryLine } from '../repository-advisory.ts'
import { isTestAdvisory } from '../test-advisories.ts'
import { parseVulnerableRange } from '../vulnerable-range.ts'
import type { Hold } from './automation.ts'
import {
  newPatchRun,
  type PatchRun,
  type RepositoryAdvisoryRecord,
  type Step,
  type UpstreamRelease
} from './patch-run.ts'
import type { AffectedVersions, Ports, RepoRef, RepositoryAdvisory } from './ports.ts'
import { watchedRuns } from './superseding.ts'

interface ReleasedRun extends PatchRun {
  release: UpstreamRelease
  fork: RepoRef
  stable: { commit: string; version: string }
}

export interface Coverage {
  advisory: Advisory
  released: ReleasedRun[]
  basedOn: ReleasedRun | undefined
}

function isReleased(run: PatchRun): run is ReleasedRun {
  return Boolean(run.release && run.fork && run.stable?.version)
}

function byVersion(a: ReleasedRun, b: ReleasedRun): number {
  return semver.compare(a.stable.version, b.stable.version)
}

function versionsText(list: AffectedVersions[]): string {
  return JSON.stringify(
    list.map(({ packageName, range, patched }) => [packageName, range, patched])
  )
}

export function isPatchedPackage(packageName: string, { npmScope }: NamingSettings): boolean {
  return packageName.startsWith(`@${npmScope}/`)
}

export function securityCoverage(
  { github, store, notifier }: Pick<Ports, 'github' | 'store' | 'notifier'>,
  settings: NamingSettings
) {
  async function releasedRuns(packageName: string, releasing?: PatchRun): Promise<ReleasedRun[]> {
    const watched = await watchedRuns(store, packageName)
    const runs = releasing
      ? [releasing, ...watched.filter((run) => run.id !== releasing.id)]
      : watched
    return runs.filter(isReleased)
  }

  function affectedVersions(advisory: Advisory, released: ReleasedRun[]): AffectedVersions[] {
    const range = parseVulnerableRange(advisory.vulnerableRange)
    if (!range) return []
    const lines = new Map<string, ReleasedRun[]>()
    for (const run of released) {
      const upstream = run.release.version
      if (range.includes(upstream)) lines.set(upstream, [...(lines.get(upstream) ?? []), run])
    }
    const packageName = patchedPackageName(advisory.packageName, settings)
    return [...lines.entries()]
      .toSorted(([a], [b]) => semver.compare(a, b))
      .flatMap(([upstream, runs]) => {
        const fix = runs.find((run) => run.ghsaId === advisory.ghsaId)?.stable.version
        if (fix && !runs.some((run) => semver.lt(run.stable.version, fix))) return []
        const first = patchedVersion(upstream, 1)
        return [
          {
            packageName,
            range: fix ? `>= ${first}, < ${fix}` : `>= ${first}`,
            patched: fix ?? null
          }
        ]
      })
  }

  async function announce(
    advisory: Advisory,
    published: RepositoryAdvisory,
    patched: string | null
  ) {
    await notifier.notify({
      type: 'repository-advisory',
      runId: `${advisory.ghsaId}:${advisory.packageName}`,
      ghsaId: advisory.ghsaId,
      packageName: advisory.packageName,
      patchedPackage: patchedPackageName(advisory.packageName, settings),
      url: published.url,
      patchedVersion: patched
    })
  }

  async function report(
    { advisory, released }: Omit<Coverage, 'basedOn'>,
    hold?: Hold
  ): Promise<RepositoryAdvisoryRecord | undefined> {
    const fork = released.toSorted(byVersion).at(-1)?.fork
    const wanted = affectedVersions(advisory, released)
    if (!fork || wanted.length === 0) return undefined
    if (hold) return { status: 'held', reason: hold.reason }
    const patchedName = patchedPackageName(advisory.packageName, settings)
    if (isTestAdvisory(advisory.ghsaId)) {
      return {
        status: 'dry-run',
        repository: fork,
        advisory: repositoryAdvisory(advisory, patchedName, wanted)
      }
    }
    const line = upstreamAdvisoryLine(advisory.ghsaId)
    const existing = (await github.listRepositoryAdvisories(fork)).find((published) =>
      published.description.includes(line)
    )
    const patched = wanted.find((entry) => entry.patched)?.patched ?? null
    if (!existing) {
      const draft = repositoryAdvisory(advisory, patchedName, wanted)
      const created = await github.createRepositoryAdvisory(fork, draft)
      await github.updateRepositoryAdvisory(fork, created.ghsaId, { state: 'published' })
      await announce(advisory, created, patched)
      return { status: 'published', url: created.url }
    }
    if (existing.state !== 'draft' && existing.state !== 'published') return undefined
    const publishedRecord = { status: 'published', url: existing.url } as const
    const changed = versionsText(existing.vulnerabilities) !== versionsText(wanted)
    if (!changed && existing.state === 'published') return publishedRecord
    await github.updateRepositoryAdvisory(fork, existing.ghsaId, {
      vulnerabilities: wanted,
      state: 'published'
    })
    const newlyPatched = patched !== null && !existing.vulnerabilities.some((v) => v.patched)
    if (existing.state === 'draft' || newlyPatched) await announce(advisory, existing, patched)
    return publishedRecord
  }

  async function currentAdvisory(run: PatchRun): Promise<Advisory> {
    const advisory = await github.getAdvisory(run.ghsaId)
    const current = advisory && npmAdvisories(advisory)
    return current?.find((entry) => entry.packageName === run.packageName) ?? run.advisory
  }

  return {
    async check(advisory: Advisory): Promise<Coverage> {
      const released = await releasedRuns(advisory.packageName)
      const latest = released.toSorted(byVersion).at(-1)
      const range = parseVulnerableRange(advisory.vulnerableRange)
      const basedOn = latest && range?.includes(latest.release.version) ? latest : undefined
      return { advisory, released, basedOn }
    },

    report,

    newRun({ advisory, basedOn }: Coverage, at: Date): PatchRun {
      const run = newPatchRun(advisory, at)
      if (!basedOn) return run
      const { release, fork, stable } = basedOn
      return {
        ...run,
        release,
        fork,
        basedOn: { runId: basedOn.id, version: stable.version, commit: stable.commit }
      }
    },

    reportOnRelease(step: Step): Step {
      return async (run) => {
        const next = await step(run)
        if (next?.to !== 'released') return next
        const releasing = { ...run, ...next.details, state: next.to }
        const record = await report({
          advisory: await currentAdvisory(run),
          released: await releasedRuns(run.packageName, releasing)
        })
        return record ? { ...next, details: { ...next.details, repositoryAdvisory: record } } : next
      }
    }
  }
}
