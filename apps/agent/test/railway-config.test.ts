import { createRailwayContext, project } from 'railway/iac'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import railway from '../../../.railway/railway.ts'
import * as env from '../src/env.ts'

async function variablesOf(service: string): Promise<string[]> {
  const definition = await railway(createRailwayContext({ environment: 'production' }), project)
  const found = (definition.resources ?? []).find(
    (resource) =>
      typeof resource === 'object' &&
      resource !== null &&
      'type' in resource &&
      resource.type === 'service' &&
      'name' in resource &&
      resource.name === service
  )
  return Object.keys((found as { variables?: object } | undefined)?.variables ?? {})
}

describe('Railway configuration', () => {
  it('lists every variable the agent reads, so an apply does not delete one', async () => {
    const listed = new Set(await variablesOf('agent'))
    const read = Object.values(env).flatMap((schema) =>
      schema instanceof z.ZodObject ? Object.keys(schema.shape) : []
    )

    expect(read.length).toBeGreaterThan(0)
    expect(read.filter((name) => !listed.has(name))).toEqual([])
  })
})
