import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { ModelAccess } from './pipeline/ports.ts'

const PREFIX = 'ptg-run'

const payloadSchema = z.object({ run: z.string(), jti: z.string(), exp: z.number() })

export interface RunTokenClaims {
  runId: string
  tokenId: string
  expiresAt: Date
}

export interface RevocationStore {
  revoke(tokenId: string, expiresAt: Date): Promise<void>
  isRevoked(tokenId: string): Promise<boolean>
}

export interface RunTokens {
  issue(runId: string, ttlMs: number): { token: string; claims: RunTokenClaims }
  verify(token: string): Promise<RunTokenClaims | null>
  revoke(token: string): Promise<void>
}

export function createMemoryRevocationStore(now: () => number = Date.now): RevocationStore {
  const revoked = new Map<string, number>()

  function prune() {
    const current = now()
    for (const [tokenId, expiresAt] of revoked) {
      if (expiresAt <= current) revoked.delete(tokenId)
    }
  }

  return {
    async revoke(tokenId, expiresAt) {
      prune()
      revoked.set(tokenId, expiresAt.getTime())
    },
    async isRevoked(tokenId) {
      return revoked.has(tokenId)
    }
  }
}

export function createRunTokens(options: {
  secret: string
  revocations: RevocationStore
  now?: () => number
}): RunTokens {
  const { secret, revocations, now = Date.now } = options

  function sign(payload: string) {
    return createHmac('sha256', secret).update(`${PREFIX}.${payload}`).digest('base64url')
  }

  function decode(token: string): RunTokenClaims | null {
    const [prefix, payload, signature, ...rest] = token.split('.')
    if (prefix !== PREFIX || !payload || !signature || rest.length > 0) return null

    const expected = Buffer.from(sign(payload))
    const actual = Buffer.from(signature)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    } catch {
      return null
    }
    const result = payloadSchema.safeParse(parsed)
    if (!result.success) return null
    const { run, jti, exp } = result.data
    return { runId: run, tokenId: jti, expiresAt: new Date(exp) }
  }

  return {
    issue(runId, ttlMs) {
      const claims = { runId, tokenId: randomUUID(), expiresAt: new Date(now() + ttlMs) }
      const payload = Buffer.from(
        JSON.stringify({ run: claims.runId, jti: claims.tokenId, exp: claims.expiresAt.getTime() })
      ).toString('base64url')
      const token = `${PREFIX}.${payload}.${sign(payload)}`
      return { token, claims }
    },
    async verify(token) {
      const claims = decode(token)
      if (!claims || claims.expiresAt.getTime() <= now()) return null
      if (await revocations.isRevoked(claims.tokenId)) return null
      return claims
    },
    async revoke(token) {
      const claims = decode(token)
      if (claims) await revocations.revoke(claims.tokenId, claims.expiresAt)
    }
  }
}

export function runTokenAccess(tokens: RunTokens, ttlMs: number): ModelAccess {
  return {
    async grant(runId) {
      const { token } = tokens.issue(runId, ttlMs)
      return { token, revoke: () => tokens.revoke(token) }
    }
  }
}
