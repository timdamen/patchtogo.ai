import { isDeepStrictEqual } from 'node:util'
import type { PackageFiles } from './pipeline/ports.ts'

export interface TarballComparison {
  matches: boolean
  missing: string[]
  differing: string[]
}

const runtimeFields = [
  'name',
  'version',
  'type',
  'main',
  'module',
  'browser',
  'exports',
  'imports',
  'bin',
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'os',
  'cpu'
] as const

function withoutDotSlash(path: string): string {
  return path.replace(/^(\.\/)+/, '')
}

function manifest(packageJson: unknown): Record<string, unknown> {
  return typeof packageJson === 'object' && packageJson !== null
    ? (packageJson as Record<string, unknown>)
    : {}
}

function runtimeView(packageJson: unknown): Record<string, unknown> {
  const pkg = manifest(packageJson)
  const view: Record<string, unknown> = {}
  for (const field of runtimeFields) {
    if (pkg[field] !== undefined) view[field] = pkg[field]
  }
  if (typeof view.main === 'string') view.main = withoutDotSlash(view.main)
  if (typeof view.bin === 'string' && typeof pkg.name === 'string') {
    view.bin = { [pkg.name.replace(/^@[^/]+\//, '')]: view.bin }
  }
  if (typeof view.bin === 'object' && view.bin !== null) {
    view.bin = Object.fromEntries(
      Object.entries(view.bin).map(([command, path]) => [
        command,
        typeof path === 'string' ? withoutDotSlash(path) : path
      ])
    )
  }
  return view
}

function packageJsonDifferences(published: unknown, built: unknown): string[] {
  const a = runtimeView(published)
  const b = runtimeView(built)
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (field) => !isDeepStrictEqual(a[field], b[field])
  )
}

export function compareTarballs(published: PackageFiles, built: PackageFiles): TarballComparison {
  const missing: string[] = []
  const differing: string[] = []
  for (const [path, hash] of Object.entries(published.files).toSorted(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (path === 'package.json') continue
    const builtHash = built.files[path]
    if (builtHash === undefined) missing.push(path)
    else if (builtHash !== hash) differing.push(path)
  }
  const fields = packageJsonDifferences(published.packageJson, built.packageJson)
  if (fields.length > 0) differing.unshift(`package.json (${fields.join(', ')})`)
  return { matches: missing.length === 0 && differing.length === 0, missing, differing }
}

function listed(label: string, paths: string[]): string | undefined {
  if (paths.length === 0) return undefined
  const shown = paths.slice(0, 5).join(', ')
  return `${paths.length} ${label} (${shown}${paths.length > 5 ? ', ...' : ''})`
}

export function describeMismatch(comparison: TarballComparison): string {
  return [
    listed('differ', comparison.differing),
    listed('missing from the build', comparison.missing)
  ]
    .filter(Boolean)
    .join('; ')
}
