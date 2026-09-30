import { PGlite, type PGliteInterface } from '@electric-sql/pglite'
import { beforeAll, onTestFinished } from 'vitest'
import { InMemoryStore } from '../../src/pipeline/memory-store.ts'
import type { Store } from '../../src/pipeline/ports.ts'
import type { Database } from '../../src/postgres/database.ts'
import { migrate } from '../../src/postgres/migrate.ts'
import { PostgresStore } from '../../src/postgres/store.ts'
import { pgliteDatabase } from './pglite.ts'

const TEMPLATE_BOOT_TIMEOUT_MS = 60_000

let blank: Promise<PGliteInterface> | undefined
let migrated: Promise<PGliteInterface> | undefined

function blankTemplate(): Promise<PGliteInterface> {
  blank ??= PGlite.create()
  return blank
}

function migratedTemplate(): Promise<PGliteInterface> {
  migrated ??= blankTemplate().then(async (template) => {
    const pglite = await template.clone()
    await migrate(pgliteDatabase(pglite))
    return pglite
  })
  return migrated
}

beforeAll(async () => {
  await migratedTemplate()
}, TEMPLATE_BOOT_TIMEOUT_MS)

async function cloneOf(
  template: Promise<PGliteInterface>
): Promise<{ pglite: PGliteInterface; db: Database }> {
  const pglite = await (await template).clone()
  onTestFinished(() => pglite.close())
  return { pglite, db: pgliteDatabase(pglite) }
}

export function blankDatabase(): Promise<{ pglite: PGliteInterface; db: Database }> {
  return cloneOf(blankTemplate())
}

export function freshDatabase(): Promise<{ pglite: PGliteInterface; db: Database }> {
  return cloneOf(migratedTemplate())
}

export const stores: [string, () => Promise<Store>][] = [
  ['in-memory', async () => new InMemoryStore()],
  ['postgres', async () => new PostgresStore((await freshDatabase()).db)]
]
