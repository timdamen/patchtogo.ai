import { readdir, readFile } from 'node:fs/promises'
import type { Database } from './database.ts'

const MIGRATIONS = new URL('../../migrations/', import.meta.url)
const MIGRATION_LOCK = 7_272_741

export async function migrate(db: Database, directory: URL = MIGRATIONS): Promise<string[]> {
  await db.exec(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `)
  const files = (await readdir(directory))
    .filter((name) => /^\d+_[\w-]+\.sql$/.test(name))
    .toSorted()

  const applied: string[] = []
  for (const name of files) {
    const sql = await readFile(new URL(name, directory), 'utf8')
    const ran = await db.transaction(async (tx) => {
      await tx.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK])
      const done = await tx.query('select 1 from schema_migrations where name = $1', [name])
      if (done.length > 0) return false
      await tx.exec(sql)
      await tx.query('insert into schema_migrations (name) values ($1)', [name])
      return true
    })
    if (ran) applied.push(name)
  }
  return applied
}
