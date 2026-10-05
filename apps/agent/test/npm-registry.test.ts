import { describe, expect, it } from 'vitest'
import { createNpmRegistry } from '../src/npm-registry.ts'

function registryServing(packument: unknown) {
  return createNpmRegistry({ fetch: async () => Response.json(packument) })
}

describe('npm registry', () => {
  it('reads the repository, commit, licence, tarball and publish time of every version', async () => {
    const registry = registryServing({
      name: '@acme/strings',
      repository: { type: 'git', url: 'git+https://github.com/acme/tools.git' },
      'dist-tags': { latest: '2.0.0', next: '3.0.0-beta.1' },
      time: { '1.0.0': '2016-01-01T00:00:00.000Z', '2.0.0': '2020-01-01T00:00:00.000Z' },
      versions: {
        '1.0.0': {
          version: '1.0.0',
          licenses: [{ type: 'MIT', url: 'http://opensource.org/licenses/MIT' }],
          dist: { tarball: 'https://registry.npmjs.org/@acme/strings/-/strings-1.0.0.tgz' }
        },
        '2.0.0': {
          version: '2.0.0',
          repository: { url: 'https://github.com/acme/tools', directory: 'packages/strings' },
          gitHead: 'abc',
          license: 'ISC',
          dist: {
            tarball: 'https://registry.npmjs.org/@acme/strings/-/strings-2.0.0.tgz',
            integrity: 'sha512-xyz'
          }
        },
        broken: { version: 'broken' }
      }
    })

    expect(await registry.getPackage('@acme/strings')).toEqual({
      name: '@acme/strings',
      latest: '2.0.0',
      versions: [
        {
          version: '1.0.0',
          repository: { url: 'git+https://github.com/acme/tools.git', directory: null },
          gitHead: null,
          license: 'MIT',
          tarball: {
            url: 'https://registry.npmjs.org/@acme/strings/-/strings-1.0.0.tgz',
            integrity: null
          },
          publishedAt: '2016-01-01T00:00:00.000Z'
        },
        {
          version: '2.0.0',
          repository: { url: 'https://github.com/acme/tools', directory: 'packages/strings' },
          gitHead: 'abc',
          license: 'ISC',
          tarball: {
            url: 'https://registry.npmjs.org/@acme/strings/-/strings-2.0.0.tgz',
            integrity: 'sha512-xyz'
          },
          publishedAt: '2020-01-01T00:00:00.000Z'
        }
      ]
    })
  })

  it('reads an unpublished package as one without a latest version', async () => {
    const registry = registryServing({
      name: 'left-pad',
      time: { unpublished: { time: '2016-03-23T00:00:00.000Z', versions: ['1.0.0'] } }
    })

    expect(await registry.getPackage('left-pad')).toEqual({
      name: 'left-pad',
      latest: null,
      versions: []
    })
  })

  it('fetches scoped packages with an encoded slash and treats 404 as unknown', async () => {
    const urls: string[] = []
    const registry = createNpmRegistry({
      fetch: async (url) => {
        urls.push(String(url))
        return new Response('{}', { status: 404 })
      }
    })

    expect(await registry.getPackage('@acme/strings')).toBeUndefined()
    expect(urls).toEqual(['https://registry.npmjs.org/@acme%2Fstrings'])
  })
})
