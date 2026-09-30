import semver from 'semver'
import { npmAdvisories } from '../advisory.ts'
import { patchedPackageName, type NamingSettings } from '../naming.ts'
import { parseVulnerableRange } from '../vulnerable-range.ts'
import type { PatchRun, RunState, Transition } from './patch-run.ts'
import type { Ports, Store } from './ports.ts'

const watchedStates: readonly RunState[] = ['released', 'upstreamed', 'failed']

function watched(run: PatchRun): boolean {
  return run.state !== 'failed' || run.failure?.step === 'released'
}

export async function watchedRuns(store: Store, packageName?: string): Promise<PatchRun[]> {
  const runs: PatchRun[] = []
  for (const state of watchedStates) runs.push(...(await store.listRuns({ state })))
  return runs.filter(
    (run) => watched(run) && (packageName === undefined || run.packageName === packageName)
  )
}

export async function watchedPackages(store: Store): Promise<string[]> {
  return [...new Set((await watchedRuns(store)).map((run) => run.packageName))].toSorted()
}

export function supersedingCheck({ github }: Pick<Ports, 'github'>, settings: NamingSettings) {
  return async function supersededBy(
    run: PatchRun,
    published: string
  ): Promise<Transition | undefined> {
    const version = semver.valid(published)
    const based = run.release?.version
    const patchedRelease = run.stable?.version
    if (!version || !based || !patchedRelease || !semver.gt(version, based)) return undefined
    const advisory = await github.getAdvisory(run.ghsaId)
    const entries = (advisory ? npmAdvisories(advisory) : [])
      .filter((entry) => entry.packageName === run.packageName)
      .map((entry) => ({ entry, range: parseVulnerableRange(entry.vulnerableRange) }))
    const ours = entries.find(({ range }) => range?.includes(based))
    const firstPatched = semver.valid(ours?.entry.patchedVersion ?? '')
    const stillVulnerable = entries.some(({ range }) => !range || range.includes(version))
    if (!firstPatched || semver.lt(version, firstPatched) || stillVulnerable) return undefined
    const upstream = `${run.packageName}@${version}`
    const message = `Superseded: ${upstream} fixes ${run.ghsaId}. Remove the patchtogo override and use ${run.packageName} ${version} or later.`
    const command = `npm deprecate '${patchedPackageName(run.packageName, settings)}@${patchedRelease}' '${message}'`
    return {
      to: 'superseded',
      reason: `${upstream} is the latest release upstream and fixes ${run.ghsaId} (first patched version ${firstPatched}). Deprecate the patched release with: ${command}`,
      details: { superseded: { version, command } }
    }
  }
}
