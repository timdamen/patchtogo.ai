import type { Pool, PoolClient } from 'pg'

export interface Sql {
  query<Row extends object>(text: string, params?: unknown[]): Promise<Row[]>
  exec(text: string): Promise<void>
}

export interface Database extends Sql {
  transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T>
}

function clientSql(client: Pool | PoolClient): Sql {
  return {
    async query<Row extends object>(text: string, params: unknown[] = []) {
      const result = await client.query(text, params)
      return result.rows as Row[]
    },
    async exec(text) {
      await client.query(text)
    }
  }
}

export function createPgDatabase(pool: Pool): Database {
  return {
    ...clientSql(pool),
    async transaction(work) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await work(clientSql(client))
        await client.query('commit')
        return result
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    }
  }
}
