import type { Advisory } from '../advisory.ts'
import type { PatchRun, RunDetails, RunFailure, RunState } from '../pipeline/patch-run.ts'
import {
  StaleRunError,
  type FixSession,
  type ModelSpend,
  type RunCost,
  type RunEvent,
  type RunFilter,
  type Store
} from '../pipeline/ports.ts'
import type { Database, Sql } from './database.ts'

interface RunRow {
  id: string
  ghsa_id: string
  package_name: string
  advisory: Advisory
  state: RunState
  reason: string | null
  failure: RunFailure | null
  details: Record<string, unknown>
  version: number
  created_at: Date
  updated_at: Date
}

interface EventRow {
  run_id: string
  version: number
  state: RunState
  reason: string | null
  failure: RunFailure | null
  at: Date
}

interface CostRow {
  run_id: string
  step: RunState
  input_tokens: number
  output_tokens: number
  cost_usd: number | null
  sandbox_seconds: number
  at: Date
}

interface SessionRow {
  session_id: string
  transcript: string
  totals: ModelSpend
}

const columnFields = new Set<string>([
  'id',
  'ghsaId',
  'packageName',
  'advisory',
  'state',
  'reason',
  'failure',
  'version',
  'createdAt',
  'updatedAt'
] satisfies (keyof PatchRun)[])

const RUN_COLUMNS =
  'id, ghsa_id, package_name, advisory, state, reason, failure, details, version, created_at, updated_at'

function detailsOf(run: PatchRun): Record<string, unknown> {
  return Object.fromEntries(Object.entries(run).filter(([field]) => !columnFields.has(field)))
}

function toRun(row: RunRow): PatchRun {
  return {
    ...(row.details as unknown as RunDetails),
    id: row.id,
    ghsaId: row.ghsa_id,
    packageName: row.package_name,
    advisory: row.advisory,
    state: row.state,
    reason: row.reason,
    failure: row.failure,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value)
}

async function recordEvent(sql: Sql, run: PatchRun): Promise<void> {
  await sql.query(
    `insert into run_events (run_id, version, state, reason, failure, at)
     values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [run.id, run.version, run.state, run.reason, json(run.failure), run.updatedAt]
  )
}

export class PostgresStore implements Store {
  #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  createRunIfAbsent(run: PatchRun): Promise<PatchRun> {
    return this.#db.transaction(async (sql) => {
      const { advisory } = run
      await sql.query(
        `insert into advisories (ghsa_id, cve_id, severity, summary, description, first_seen_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $6)
         on conflict (ghsa_id) do update set
           cve_id = excluded.cve_id,
           severity = excluded.severity,
           summary = excluded.summary,
           description = excluded.description,
           updated_at = excluded.updated_at`,
        [
          advisory.ghsaId,
          advisory.cveId,
          advisory.severity,
          advisory.summary,
          advisory.description,
          run.createdAt
        ]
      )
      const inserted = await sql.query(
        `insert into patch_runs (${RUN_COLUMNS})
         values ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
         on conflict (id) do nothing
         returning id`,
        [
          run.id,
          run.ghsaId,
          run.packageName,
          json(run.advisory),
          run.state,
          run.reason,
          json(run.failure),
          json(detailsOf(run)),
          run.version,
          run.createdAt,
          run.updatedAt
        ]
      )
      if (inserted.length > 0) await recordEvent(sql, run)
      const [stored] = await sql.query<RunRow>(
        `select ${RUN_COLUMNS} from patch_runs where id = $1`,
        [run.id]
      )
      if (!stored) throw new Error(`patch run ${run.id} vanished`)
      return toRun(stored)
    })
  }

  async getRun(id: string): Promise<PatchRun | undefined> {
    const [row] = await this.#db.query<RunRow>(
      `select ${RUN_COLUMNS} from patch_runs where id = $1`,
      [id]
    )
    return row && toRun(row)
  }

  async listRuns(filter: RunFilter = {}): Promise<PatchRun[]> {
    const rows = await this.#db.query<RunRow>(
      `select ${RUN_COLUMNS} from patch_runs
       where ($1::text is null or ghsa_id = $1) and ($2::text is null or state = $2)
       order by seq`,
      [filter.ghsaId ?? null, filter.state ?? null]
    )
    return rows.map(toRun)
  }

  saveRun(run: PatchRun): Promise<void> {
    return this.#db.transaction(async (sql) => {
      const updated = await sql.query(
        `update patch_runs set
           advisory = $3::jsonb,
           state = $4,
           reason = $5,
           failure = $6::jsonb,
           details = $7::jsonb,
           version = $8,
           updated_at = $9
         where id = $1 and version = $2
         returning id`,
        [
          run.id,
          run.version - 1,
          json(run.advisory),
          run.state,
          run.reason,
          json(run.failure),
          json(detailsOf(run)),
          run.version,
          run.updatedAt
        ]
      )
      if (updated.length === 0) {
        throw new StaleRunError(`patch run ${run.id} changed since version ${run.version - 1}`)
      }
      await recordEvent(sql, run)
    })
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    const rows = await this.#db.query<EventRow>(
      `select run_id, version, state, reason, failure, at from run_events
       where run_id = $1 order by version`,
      [runId]
    )
    return rows.map((row) => ({
      runId: row.run_id,
      version: row.version,
      state: row.state,
      reason: row.reason,
      failure: row.failure,
      at: row.at
    }))
  }

  async recordCost(cost: RunCost): Promise<void> {
    await this.#db.query(
      `insert into run_costs (run_id, step, input_tokens, output_tokens, cost_usd, sandbox_seconds, at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        cost.runId,
        cost.step,
        cost.inputTokens,
        cost.outputTokens,
        cost.costUsd,
        cost.sandboxSeconds,
        cost.at
      ]
    )
  }

  async listCosts(runId: string): Promise<RunCost[]> {
    const rows = await this.#db.query<CostRow>(
      `select run_id, step, input_tokens, output_tokens, cost_usd, sandbox_seconds, at
       from run_costs where run_id = $1 order by id`,
      [runId]
    )
    return rows.map((row) => ({
      runId: row.run_id,
      step: row.step,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
      sandboxSeconds: row.sandbox_seconds,
      at: row.at
    }))
  }

  async saveSession(runId: string, session: FixSession): Promise<void> {
    await this.#db.query(
      `insert into run_sessions (run_id, session_id, transcript, totals, updated_at)
       values ($1, $2, $3, $4::jsonb, now())
       on conflict (run_id) do update set
         session_id = excluded.session_id,
         transcript = excluded.transcript,
         totals = excluded.totals,
         updated_at = excluded.updated_at`,
      [runId, session.id, session.transcript, json(session.totals)]
    )
  }

  async getSession(runId: string): Promise<FixSession | undefined> {
    const [row] = await this.#db.query<SessionRow>(
      'select session_id, transcript, totals from run_sessions where run_id = $1',
      [runId]
    )
    return row && { id: row.session_id, transcript: row.transcript, totals: row.totals }
  }
}
