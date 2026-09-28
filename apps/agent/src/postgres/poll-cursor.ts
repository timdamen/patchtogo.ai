import type { PollCursor } from '../advisory-poller.ts'
import type { Database } from './database.ts'

export function createPgPollCursor(
  db: Database,
  options: { name: string; initial: () => Date }
): PollCursor {
  const { name, initial } = options
  return {
    async get() {
      const [row] = await db.query<{ position: Date }>(
        'select position from poll_cursors where name = $1',
        [name]
      )
      return row ? new Date(row.position) : initial()
    },
    async set(value) {
      await db.query(
        `insert into poll_cursors (name, position) values ($1, $2)
         on conflict (name) do update set position = excluded.position`,
        [name, value]
      )
    }
  }
}
