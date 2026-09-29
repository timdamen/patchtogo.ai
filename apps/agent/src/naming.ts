export interface NamingSettings {
  npmScope: string
}

export const BRANCH_NAMESPACE = 'ptg/'

const BASE_BRANCH_PREFIX = `${BRANCH_NAMESPACE}base/`

const PATCH_BRANCH_PREFIX = `${BRANCH_NAMESPACE}patch/`

export function packageSlug(packageName: string): string {
  const scoped = /^@([^/]+)\/(.+)$/.exec(packageName)
  const slug = scoped ? `${scoped[1]}__${scoped[2]}` : packageName
  return slug.toLowerCase().replaceAll(/[^a-z0-9._-]/g, '-')
}

export function patchedPackageName(packageName: string, { npmScope }: NamingSettings): string {
  return `@${npmScope}/${packageSlug(packageName)}`
}

export function patchedVersion(upstreamVersion: string, release: number): string {
  return `${upstreamVersion}-ptg.${release}`
}

export function baseBranchName(packageName: string, upstreamVersion: string): string {
  return `${BASE_BRANCH_PREFIX}${packageSlug(packageName)}/${upstreamVersion}`
}

export function patchBranchName(
  packageName: string,
  upstreamVersion: string,
  ghsaId: string
): string {
  return `${PATCH_BRANCH_PREFIX}${packageSlug(packageName)}/${upstreamVersion}/${ghsaId.toLowerCase()}`
}
