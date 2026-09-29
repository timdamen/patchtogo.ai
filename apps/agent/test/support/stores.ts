import type { PGliteInterface } from '@electric-sql/pglite'
import { beforeAll, onTestFinished } from 'vitest'
import { InMemoryStore } from '../../src/pipeline/memory-store.ts'
import type { Store } from '../../src/pipeline/ports.ts'
import type { Database } from '../../src/postgres/database.ts'
import { PostgresStore } from '../../src/postgres/store.ts'
import { migratedDatabase, pgliteDatabase } from './pglite.ts'

const TEMPLATE_BOOT_TIMEOUT_MS = 60_000

let template: Promise<PGliteInterface> | undefined

function migratedTemplate(): Promise<PGliteInterface> {
  template ??= migratedDatabase().then(({ pglite }) => pglite)
  return template
}

beforeAll(async () => {
  await migratedTemplate()
}, TEMPLATE_BOOT_TIMEOUT_MS)

export async function freshDatabase(): Promise<{ pglite: PGliteInterface; db: Database }> {
  const pglite = await (await migratedTemplate()).clone()
  onTestFinished(() => pglite.close())
  return { pglite, db: pgliteDatabase(pglite) }
}

export const stores: [string, () => Promise<Store>][] = [
  ['in-memory', async () => new InMemoryStore()],
  ['postgres', async () => new PostgresStore((await freshDatabase()).db)]
]
