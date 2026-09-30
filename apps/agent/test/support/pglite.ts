import type { PGliteInterface, Transaction } from '@electric-sql/pglite'
import type { Database, Sql } from '../../src/postgres/database.ts'

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
