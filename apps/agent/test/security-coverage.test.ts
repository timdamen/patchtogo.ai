import { describe, expect, it } from 'vitest'
import type { SecurityAdvisory } from '../src/advisory.ts'
import type { FixResult } from '../src/pipeline/ports.ts'
import {
  advisory as firstAdvisory,
  baseBranch,
  fixDiff,
  fixedIndex,
  fixResult,
  fork,
  patchBranch,
  runId as firstRunId,
  setupPatchRun
} from './fakes/escape-html-fix.ts'
import { stores } from './support/stores.ts'

const patched = '@patchtogo.ai/escape-html'
const laterGhsa = 'GHSA-7q2m-5x9v-c4hw'
const laterRunId = `${laterGhsa}:escape-html`
const laterPatchBranch = `ptg/patch/escape-html/1.0.3/${laterGhsa.toLowerCase()}`
const upstreamRepository = {
  url: 'git+https://github.com/component/escape-html.git',
  directory: null
}

const laterIndex =
  "module.exports = (s) => String(s).replaceAll('<', '&lt;').replaceAll('>', '&gt;')\n"
const laterTest =
  "const escape = require('../index.js')\nif (escape('>') !== '&gt;') process.exit(1)\n"
const laterFix = fixResult({
  diff: fixDiff(laterIndex, laterTest, { from: fixedIndex, testPath: 'test/gt.js' }),
  summary: 'index.js now also escapes >.'
})

function laterAdvisory(
  vulnerableRange: string,
  patchedVersion: string | null = null,
  packageName = 'escape-html'
): SecurityAdvisory {
  return {
    ghsaId: laterGhsa,
    type: 'reviewed',
    cveId: 'CVE-2099-0002',
    summary: 'escape-html leaves > unescaped',
    description: 'A second XSS in escape-html.',
    severity: 'high',
    vulnerabilities: [{ ecosystem: 'npm', packageName, vulnerableRange, patchedVersion }]
  }
}

describe.each(stores)('security coverage on the %s store', (_name, createStore) => {
  async function setup(fixes: (FixResult | Error)[]) {
    const test = await setupPatchRun(await createStore(), [fixResult(), ...fixes])
    test.registry.publish(patched, '0.0.0-ptg.0')
    await test.publish()

    async function release(number: number, head: string, version: string): Promise<string> {
      const commit = test.github.mergePullRequest(fork, number)
      await test.pipeline.handle({
        type: 'pull-request-closed',
        pullRequest: { repository: fork, number, head },
        mergeCommit: commit
      })
      test.registry.publish(patched, version, { gitHead: commit })
      await test.pipeline.handle({
        type: 'stable-release-completed',
        repository: fork,
        headRepository: fork,
        trigger: 'push',
        branch: baseBranch,
        commit,
        workflowRun: {
          id: number,
          url: `https://github.com/${fork.owner}/actions/runs/${number}`,
          conclusion: 'success'
        }
      })
      return commit
    }

    async function announce(advisory: SecurityAdvisory) {
      test.github.publishAdvisory(advisory)
      await test.pipeline.handle({ type: 'advisory-published', ghsaId: advisory.ghsaId })
    }

    const laterRun = () => test.store.getRun(laterRunId)
    const advisoryNotifications = () =>
      test.notifier.notifications.filter((n) => n.type === 'repository-advisory')

    return { ...test, release, announce, laterRun, advisoryNotifications }
  }

  async function afterFirstRelease(fixes: (FixResult | Error)[] = []) {
    const test = await setup(fixes)
    const commit = await test.release(1, patchBranch, '1.0.3-ptg.1')
    expect(await test.store.getRun(firstRunId)).toMatchObject({
      state: 'released',
      stable: { version: '1.0.3-ptg.1' }
    })
    return { ...test, firstRelease: commit }
  }

  it.each([
    ['an unpatched advisory that also covers a newer upstream release', '<= 1.0.4', null, '1.0.4'],
    ['an advisory upstream has already patched', '< 1.0.5', '1.0.5', '1.0.5']
  ])(
    'publishes an advisory for the released package and builds the follow-up on its stable release, for %s',
    async (_case, range, upstreamFix, upstreamLatest) => {
      const test = await afterFirstRelease([laterFix])
      test.registry.publish('escape-html', upstreamLatest, { repository: upstreamRepository })

      await test.announce(laterAdvisory(range, upstreamFix))

      expect(test.github.repositoryAdvisories).toEqual([
        expect.objectContaining({
          repo: 'patchtogo-ai/escape-html',
          state: 'published',
          severity: 'high',
          summary: `${laterGhsa} in escape-html also affects ${patched}`,
          description: expect.stringContaining(
            `Upstream advisory: https://github.com/advisories/${laterGhsa}`
          ),
          vulnerabilities: [{ packageName: patched, range: '>= 1.0.3-ptg.1', patched: null }]
        })
      ])
      const [published] = test.github.repositoryAdvisories
      expect(test.advisoryNotifications()).toEqual([
        {
          type: 'repository-advisory',
          runId: laterRunId,
          ghsaId: laterGhsa,
          packageName: 'escape-html',
          patchedPackage: patched,
          url: published?.url,
          patchedVersion: null
        }
      ])

      expect(await test.laterRun()).toMatchObject({
        state: 'in-review',
        basedOn: { runId: firstRunId, version: '1.0.3-ptg.1', commit: test.firstRelease },
        baseBranch: { name: baseBranch, sha: test.firstRelease },
        triage: { decision: 'patch' }
      })
      expect(test.fixer.requests.at(-1)?.source).toEqual({
        repository: 'patchtogo-ai/escape-html',
        branch: test.firstRelease
      })
      expect(test.github.pullRequests.at(-1)).toMatchObject({
        head: laterPatchBranch,
        base: baseBranch
      })
      expect(test.github.changedFiles(fork, baseBranch, laterPatchBranch)).toEqual({
        'index.js': laterIndex,
        'test/gt.js': laterTest
      })
    }
  )

  it("marks the advisory patched when the follow-up's stable release lands", async () => {
    const test = await afterFirstRelease([laterFix])
    await test.announce(laterAdvisory('<= 1.0.3'))

    await test.release(2, laterPatchBranch, '1.0.3-ptg.2')

    expect(await test.laterRun()).toMatchObject({
      state: 'released',
      stable: { version: '1.0.3-ptg.2' }
    })
    expect(test.github.repositoryAdvisories).toEqual([
      expect.objectContaining({
        state: 'published',
        vulnerabilities: [
          { packageName: patched, range: '>= 1.0.3-ptg.1, < 1.0.3-ptg.2', patched: '1.0.3-ptg.2' }
        ]
      })
    ])
    expect(
      test.advisoryNotifications().map((n) => n.type === 'repository-advisory' && n.patchedVersion)
    ).toEqual([null, '1.0.3-ptg.2'])
  })

  it('keeps the advisory published without a patched version when the follow-up needs a human', async () => {
    const test = await afterFirstRelease([
      fixResult({ regressionBefore: { passed: true, output: 'already escaped' } })
    ])

    await test.announce(laterAdvisory('<= 1.0.3'))

    expect((await test.laterRun())?.state).toBe('needs-human')
    expect(test.notifier.notifications.at(-1)).toMatchObject({
      type: 'needs-human',
      runId: laterRunId
    })
    expect(test.github.repositoryAdvisories).toEqual([
      expect.objectContaining({
        state: 'published',
        vulnerabilities: [{ packageName: patched, range: '>= 1.0.3-ptg.1', patched: null }]
      })
    ])
  })

  it('publishes the advisory once when publishing fails and the advisory is delivered again', async () => {
    const test = await afterFirstRelease([laterFix])
    test.github.failNext('updateRepositoryAdvisory')

    await expect(test.announce(laterAdvisory('<= 1.0.3'))).rejects.toThrow(
      'updateRepositoryAdvisory failed'
    )
    expect((await test.laterRun())?.state).toBe('in-review')

    await test.announce(laterAdvisory('<= 1.0.3'))

    expect(test.github.repositoryAdvisories).toEqual([
      expect.objectContaining({ state: 'published' })
    ])
    expect(test.advisoryNotifications()).toHaveLength(1)
  })

  it.each([
    ['patchtogo never released the package', false, '<= 1.0.3'],
    ["the range misses the released package's upstream version", true, '< 1.0.3']
  ])('does nothing extra when %s', async (_case, released, range) => {
    const test = released ? await afterFirstRelease() : await setup([])

    await test.announce(laterAdvisory(range))

    expect(test.github.repositoryAdvisories).toEqual([])
    expect(test.advisoryNotifications()).toEqual([])
    expect((await test.laterRun())?.basedOn).toBeUndefined()
  })

  it("ignores advisories on patchtogo's own packages", async () => {
    const test = await afterFirstRelease()

    await test.announce(laterAdvisory('<= 1.0.3-ptg.1', null, patched))

    expect(await test.store.listRuns({ ghsaId: laterGhsa })).toEqual([])
    expect(test.github.repositoryAdvisories).toEqual([])
  })

  it('leaves the first advisory alone once its own release fixed it', async () => {
    const test = await afterFirstRelease()

    await test.announce(firstAdvisory)

    expect(test.github.repositoryAdvisories).toEqual([])
  })
})
