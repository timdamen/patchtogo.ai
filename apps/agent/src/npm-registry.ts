import { z } from 'zod'
import type { PublishedPackage, PublishedVersion, Registry } from './pipeline/ports.ts'

const repositorySchema = z.union([
  z.string(),
  z.looseObject({ url: z.string().optional(), directory: z.string().optional() })
])

const licenseSchema = z.union([z.string(), z.looseObject({ type: z.string().optional() })])

const versionSchema = z.looseObject({
  version: z.string(),
  repository: repositorySchema.optional().catch(undefined),
  gitHead: z.string().optional().catch(undefined),
  license: licenseSchema.optional().catch(undefined),
  licenses: z.array(licenseSchema).optional().catch(undefined),
  dist: z.looseObject({ tarball: z.string(), integrity: z.string().optional() })
})

const packumentSchema = z.looseObject({
  name: z.string(),
  repository: repositorySchema.optional().catch(undefined),
  versions: z.record(z.string(), z.unknown()).default({}),
  time: z.record(z.string(), z.string()).optional().catch(undefined)
})

type Repository = z.infer<typeof repositorySchema>
type License = z.infer<typeof licenseSchema>

function repository(value: Repository | undefined): PublishedVersion['repository'] {
  if (value === undefined) return null
  if (typeof value === 'string') return value ? { url: value, directory: null } : null
  return value.url ? { url: value.url, directory: value.directory ?? null } : null
}

function license(value: License | undefined): string | null {
  if (value === undefined) return null
  return (typeof value === 'string' ? value : value.type) || null
}

export function parsePackument(raw: unknown): PublishedPackage {
  const packument = packumentSchema.parse(raw)
  const versions: PublishedVersion[] = []
  for (const entry of Object.values(packument.versions)) {
    const parsed = versionSchema.safeParse(entry)
    if (!parsed.success) continue
    const v = parsed.data
    versions.push({
      version: v.version,
      repository: repository(v.repository ?? packument.repository),
      gitHead: v.gitHead ?? null,
      license: license(v.license ?? v.licenses?.[0]),
      tarball: { url: v.dist.tarball, integrity: v.dist.integrity ?? null },
      publishedAt: packument.time?.[v.version] ?? null
    })
  }
  return { name: packument.name, versions }
}

export interface NpmRegistryOptions {
  registryUrl?: string
  fetch?: typeof fetch
}

export function createNpmRegistry({
  registryUrl = 'https://registry.npmjs.org',
  fetch: fetchImpl = fetch
}: NpmRegistryOptions = {}): Registry {
  return {
    async getPackage(name) {
      const response = await fetchImpl(`${registryUrl}/${name.replace('/', '%2F')}`, {
        headers: { accept: 'application/json' }
      })
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(`npm registry ${name}: HTTP ${response.status}`)
      return parsePackument(await response.json())
    }
  }
}
