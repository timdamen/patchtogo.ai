import type { FixRequest, FixResult, Fixer } from '../../src/pipeline/ports.ts'

export class ScriptedFixer implements Fixer {
  readonly requests: FixRequest[] = []
  readonly #results: FixResult[]

  constructor(results: FixResult[] = []) {
    this.#results = [...results]
  }

  fix(request: FixRequest): Promise<FixResult> {
    this.requests.push(structuredClone(request))
    const result = this.#results.shift()
    if (!result) return Promise.reject(new Error(`no scripted fix left for ${request.runId}`))
    return Promise.resolve(structuredClone(result))
  }
}
