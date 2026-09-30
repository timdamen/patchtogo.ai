import { Pool } from 'pg'
import { PgBoss } from 'pg-boss'
import { createPgDatabase, type Database } from './database.ts'
import { migrate } from './migrate.ts'

export interface Postgres {
  db: Database
  boss: PgBoss
  close(options?: { graceful?: boolean; timeoutMs?: number }): Promise<void>
}

export async function openPostgres(
  connectionString: string,
  { maintenance }: { maintenance: boolean }
): Promise<Postgres> {
  const pool = new Pool({ connectionString, max: 5 })
  pool.on('error', (error) => console.error('postgres pool error', error))
  const db = createPgDatabase(pool)

  const applied = await migrate(db)
  if (applied.length > 0) console.log(`applied migrations: ${applied.join(', ')}`)

  const boss = new PgBoss({
    connectionString,
    max: 5,
    supervise: maintenance,
    schedule: maintenance
  })
  boss.on('error', (error) => console.error('pg-boss error', error))
  await boss.start()

  return {
    db,
    boss,
    async close({ graceful = true, timeoutMs = 20_000 } = {}) {
      await boss.stop({ graceful, timeout: timeoutMs })
      await pool.end()
    }
  }
}
