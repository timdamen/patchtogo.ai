import { PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite'
import type { Database, Sql } from '../../src/postgres/database.ts'
import { migrate } from '../../src/postgres/migrate.ts'

function pgliteSql(client: PGliteInterface | Transaction): Sql {
  return {
    async query<Row extends object>(text: string, params: unknown[] = []) {
      const result = await client.query<Row>(text, params)
      return result.rows
    },
    async exec(text) {
      await client.exec(text)
    }
  }
}

export function pgliteDatabase(pglite: PGliteInterface): Database {
  return {
    ...pgliteSql(pglite),
    transaction: (work) => pglite.transaction((tx) => work(pgliteSql(tx)))
  }
}

export async function migratedDatabase(): Promise<{ pglite: PGliteInterface; db: Database }> {
  const pglite = await PGlite.create()
  const db = pgliteDatabase(pglite)
  await migrate(db)
  return { pglite, db }
}
