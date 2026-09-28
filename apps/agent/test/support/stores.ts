import type { PGliteInterface } from '@electric-sql/pglite'
import { onTestFinished } from 'vitest'
import { InMemoryStore } from '../../src/pipeline/memory-store.ts'
import type { Store } from '../../src/pipeline/ports.ts'
import type { Database } from '../../src/postgres/database.ts'
import { PostgresStore } from '../../src/postgres/store.ts'
import { migratedDatabase, pgliteDatabase } from './pglite.ts'

let template: Promise<PGliteInterface> | undefined

export async function freshDatabase(): Promise<{ pglite: PGliteInterface; db: Database }> {
  template ??= migratedDatabase().then(({ pglite }) => pglite)
  const pglite = await (await template).clone()
  onTestFinished(() => pglite.close())
  return { pglite, db: pgliteDatabase(pglite) }
}

export const stores: [string, () => Promise<Store>][] = [
  ['in-memory', async () => new InMemoryStore()],
  ['postgres', async () => new PostgresStore((await freshDatabase()).db)]
]
