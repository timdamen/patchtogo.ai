import { Webhooks } from '@octokit/webhooks'
import { describe, expect, it } from 'vitest'
import type { SecurityAdvisory } from '../src/advisory.ts'
import { forwardSecurityAdvisories } from '../src/advisory-webhook.ts'
import type { PipelineEvent } from '../src/pipeline/events.ts'
import { createServer } from '../src/server.ts'
import { createTestPipeline } from './fakes/pipeline.ts'

const ghsaId = 'GHSA-p6mc-m468-83gw'

function securityAdvisoryWebhook(emit?: (event: PipelineEvent) => Promise<void>) {
  const webhooks = new Webhooks({ secret: 'test-secret' })
  const events: PipelineEvent[] = []
  forwardSecurityAdvisories(
    webhooks,
    emit ??
      (async (event) => {
        events.push(event)
      })
  )
  const app = createServer(webhooks)

  async function deliver(action: string, options: { signature?: string } = {}) {
    const body = JSON.stringify({ action, security_advisory: { ghsa_id: ghsaId } })
    return app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'security_advisory',
        'x-hub-signature-256': options.signature ?? (await webhooks.sign(body)),
        'content-type': 'application/json'
      },
      body
    })
  }

  return { events, deliver }
}

describe('security_advisory webhook', () => {
  it.each(['published', 'updated'])('turns a %s advisory into a pipeline event', async (action) => {
    const { events, deliver } = securityAdvisoryWebhook()

    const response = await deliver(action)

    expect(response.status).toBe(202)
    expect(events).toEqual([{ type: 'advisory-published', ghsaId }])
  })

  it('ignores a withdrawn advisory', async () => {
    const { events, deliver } = securityAdvisoryWebhook()

    const response = await deliver('withdrawn')

    expect(response.status).toBe(202)
    expect(events).toEqual([])
  })

  it('rejects a delivery with a bad signature without emitting anything', async () => {
    const { events, deliver } = securityAdvisoryWebhook()

    const response = await deliver('published', { signature: 'sha256=deadbeef' })

    expect(response.status).toBe(401)
    expect(events).toEqual([])
  })

  it('creates no duplicate runs when GitHub redelivers the same delivery', async () => {
    const { pipeline, github, registry, store, model } = createTestPipeline({
      triage: () => ({ decision: 'skip', reason: 'test', suspectedFiles: [], fixStrategy: '' })
    })
    github.publishAdvisory(lodashSetAdvisory('reviewed'))
    registry.publish('lodash.set', '4.3.2')
    const { deliver } = securityAdvisoryWebhook((event) => pipeline.handle(event))

    await deliver('published')
    const before = await store.listRuns({ ghsaId })
    await deliver('published')

    expect(before).toHaveLength(1)
    expect(await store.listRuns({ ghsaId })).toEqual(before)
    expect(model.doGenerateCalls).toHaveLength(1)
  })

  it('creates no runs for a malware advisory', async () => {
    const { pipeline, github, registry, store, model } = createTestPipeline()
    github.publishAdvisory(lodashSetAdvisory('malware'))
    registry.publish('lodash.set', '4.3.2')
    const { deliver } = securityAdvisoryWebhook((event) => pipeline.handle(event))

    const response = await deliver('published')

    expect(response.status).toBe(202)
    expect(await store.listRuns()).toEqual([])
    expect(model.doGenerateCalls).toHaveLength(0)
  })
})

function lodashSetAdvisory(type: SecurityAdvisory['type']): SecurityAdvisory {
  return {
    ghsaId,
    type,
    cveId: null,
    summary: 'Prototype Pollution in lodash.set',
    description: '',
    severity: 'high',
    vulnerabilities: [
      {
        ecosystem: 'npm',
        packageName: 'lodash.set',
        vulnerableRange: '<= 4.3.2',
        patchedVersion: null
      }
    ]
  }
}
