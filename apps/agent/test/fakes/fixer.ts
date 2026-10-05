import type {
  FixRequest,
  FixResult,
  Fixer,
  ModelAccess,
  ModelGrant
} from '../../src/pipeline/ports.ts'

export class ScriptedFixer implements Fixer {
  readonly requests: FixRequest[] = []
  readonly #results: (FixResult | Error)[]

  constructor(results: (FixResult | Error)[] = []) {
    this.#results = [...results]
  }

  fix(request: FixRequest): Promise<FixResult> {
    this.requests.push(structuredClone(request))
    const result = this.#results.shift()
    if (!result) return Promise.reject(new Error(`no scripted fix left for ${request.runId}`))
    if (result instanceof Error) return Promise.reject(result)
    return Promise.resolve(structuredClone(result))
  }
}

export class RecordingModelAccess implements ModelAccess {
  readonly issued: { runId: string; token: string }[] = []
  readonly revoked: string[] = []

  grant(runId: string): Promise<ModelGrant> {
    const token = `ptg-run.${this.issued.length + 1}`
    this.issued.push({ runId, token })
    return Promise.resolve({
      token,
      revoke: () => {
        this.revoked.push(token)
        return Promise.resolve()
      }
    })
  }

  active(): string[] {
    return this.issued.map(({ token }) => token).filter((token) => !this.revoked.includes(token))
  }
}
