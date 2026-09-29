import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { newPatchRun } from '../src/pipeline/patch-run.ts'
import { migrate } from '../src/postgres/migrate.ts'
import { createPgPollCursor } from '../src/postgres/poll-cursor.ts'
import { createPgRevocationStore } from '../src/postgres/revocations.ts'
import { PostgresStore } from '../src/postgres/store.ts'
import {
  createMemoryRevocationStore,
  createRunTokens,
  type RevocationStore
} from '../src/run-tokens.ts'
import { pgliteDatabase } from './support/pglite.ts'
import { freshDatabase } from './support/stores.ts'

const HOUR = 3_600_000
const SECRET = 'a-run-token-secret-that-is-long-enough'

describe('migrate', () => {
  it('applies each migration once, in order, and records it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ptg-migrations-'))
    await writeFile(join(directory, '0002_second.sql'), 'insert into log values (2);')
    await writeFile(
      join(directory, '0001_first.sql'),
      'create table log (n int); insert into log values (1);'
    )
    await writeFile(join(directory, 'notes.txt'), 'not a migration')
    const pglite = await PGlite.create()
    const db = pgliteDatabase(pglite)
    const url = pathToFileURL(`${directory}/`)

    expect(await migrate(db, url)).toEqual(['0001_first.sql', '0002_second.sql'])
    expect(await migrate(db, url)).toEqual([])
    expect(await db.query('select n from log order by n')).toEqual([{ n: 1 }, { n: 2 }])
    await pglite.close()
  })

  it('rolls a failing migration back and applies it on the next start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ptg-migrations-'))
    await writeFile(join(directory, '0001_broken.sql'), 'create table t (n int); select nope;')
    const pglite = await PGlite.create()
    const db = pgliteDatabase(pglite)
    const url = pathToFileURL(`${directory}/`)

    await expect(migrate(db, url)).rejects.toThrow()
    expect(await db.query("select to_regclass('t') as t")).toEqual([{ t: null }])

    await writeFile(join(directory, '0001_broken.sql'), 'create table t (n int);')
    expect(await migrate(db, url)).toEqual(['0001_broken.sql'])
    await pglite.close()
  })
})

describe('the postgres store', () => {
  it('keeps the latest version of each advisory it has seen', async () => {
    const { db } = await freshDatabase()
    const store = new PostgresStore(db)
    const advisory = {
      ghsaId: 'GHSA-p6mc-m468-83gw',
      cveId: null,
      packageName: 'lodash.set',
      vulnerableRange: '<= 4.3.2',
      patchedVersion: null,
      severity: 'moderate' as const,
      summary: 'Prototype Pollution',
      description: 'first'
    }
    const first = new Date('2026-09-28T10:00:00Z')
    const second = new Date('2026-09-28T11:00:00Z')

    await store.createRunIfAbsent(newPatchRun(advisory, first))
    await store.createRunIfAbsent(
      newPatchRun(
        { ...advisory, packageName: 'lodash.setwith', severity: 'high', cveId: 'CVE-2020-8203' },
        second
      )
    )

    expect(await db.query('select * from advisories')).toEqual([
      {
        ghsa_id: advisory.ghsaId,
        cve_id: 'CVE-2020-8203',
        severity: 'high',
        summary: 'Prototype Pollution',
        description: 'first',
        first_seen_at: first,
        updated_at: second
      }
    ])
  })
})

const revocationStores: [string, () => Promise<RevocationStore>][] = [
  ['in-memory', async () => createMemoryRevocationStore()],
  ['postgres', async () => createPgRevocationStore((await freshDatabase()).db)]
]

describe.each(revocationStores)('the %s revocation store', (_name, createRevocations) => {
  it('stops a revoked token and leaves other tokens working', async () => {
    const tokens = createRunTokens({ secret: SECRET, revocations: await createRevocations() })
    const revoked = tokens.issue('GHSA-p6mc-m468-83gw:lodash.set', HOUR)
    const other = tokens.issue('GHSA-p6mc-m468-83gw:lodash.set', HOUR)

    await tokens.revoke(revoked.token)
    await tokens.revoke(revoked.token)

    expect(await tokens.verify(revoked.token)).toBeNull()
    expect(await tokens.verify(other.token)).toEqual(other.claims)
  })

  it('forgets revocations once the token has expired anyway', async () => {
    const revocations = await createRevocations()

    await revocations.revoke('old', new Date(Date.now() - 1000))
    expect(await revocations.isRevoked('old')).toBe(true)
    await revocations.revoke('new', new Date(Date.now() + HOUR))

    expect(await revocations.isRevoked('old')).toBe(false)
    expect(await revocations.isRevoked('new')).toBe(true)
  })
})

describe('the postgres revocation store', () => {
  it('keeps revocations across restarts', async () => {
    const { db } = await freshDatabase()
    const before = createRunTokens({ secret: SECRET, revocations: createPgRevocationStore(db) })
    const { token } = before.issue('GHSA-p6mc-m468-83gw:lodash.set', HOUR)
    await before.revoke(token)

    const after = createRunTokens({ secret: SECRET, revocations: createPgRevocationStore(db) })

    expect(await after.verify(token)).toBeNull()
  })
})

const lookback = new Date('2026-09-27T10:00:00Z')

describe('the postgres poll cursor', () => {
  it('starts at the lookback and then follows what was set', async () => {
    const { db } = await freshDatabase()
    const cursor = createPgPollCursor(db, { name: 'github-advisories', initial: () => lookback })
    expect(await cursor.get()).toEqual(lookback)

    await cursor.set(new Date('2026-09-28T09:30:00.123Z'))
    await cursor.set(new Date('2026-09-28T10:30:00.456Z'))

    expect(await cursor.get()).toEqual(new Date('2026-09-28T10:30:00.456Z'))
  })

  it('keeps its position across restarts and per name', async () => {
    const { db } = await freshDatabase()
    const initial = () => lookback
    await createPgPollCursor(db, { name: 'github-advisories', initial }).set(
      new Date('2026-09-28T10:30:00Z')
    )

    expect(await createPgPollCursor(db, { name: 'github-advisories', initial }).get()).toEqual(
      new Date('2026-09-28T10:30:00Z')
    )
    expect(await createPgPollCursor(db, { name: 'other', initial }).get()).toEqual(lookback)
  })
})
