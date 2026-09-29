import type { RevocationStore } from '../run-tokens.ts'
import type { Database } from './database.ts'

export function createPgRevocationStore(db: Database): RevocationStore {
  return {
    async revoke(tokenId, expiresAt) {
      await db.transaction(async (sql) => {
        await sql.query('delete from run_token_revocations where expires_at <= $1', [new Date()])
        await sql.query(
          `insert into run_token_revocations (token_id, expires_at) values ($1, $2)
           on conflict (token_id) do update set expires_at = excluded.expires_at`,
          [tokenId, expiresAt]
        )
      })
    },
    async isRevoked(tokenId) {
      const rows = await db.query('select 1 from run_token_revocations where token_id = $1', [
        tokenId
      ])
      return rows.length > 0
    }
  }
}
