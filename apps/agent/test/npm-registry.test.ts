import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseChecksums, verifyIntegrity } from '../src/builder/sandbox-builder.ts'
import { createNpmRegistry, parsePackument } from '../src/npm-registry.ts'

describe('npm registry', () => {
  it('reads the repository, commit, licence, tarball and publish time of every version', () => {
    const published = parsePackument({
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

    expect(published).toEqual({
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

  it('reads an unpublished package as one without a latest version', () => {
    expect(
      parsePackument({
        name: 'left-pad',
        time: { unpublished: { time: '2016-03-23T00:00:00.000Z', versions: ['1.0.0'] } }
      })
    ).toEqual({ name: 'left-pad', latest: null, versions: [] })
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

describe('sandbox build helpers', () => {
  it('parses sha256sum output into package-relative paths', () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    expect(parseChecksums(`${a}  ./package.json\n${b}  ./lib/index.js\n`)).toEqual({
      'package.json': a,
      'lib/index.js': b
    })
  })

  it('checks the downloaded tarball against its npm integrity', () => {
    const tarball = new TextEncoder().encode('tarball')
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`

    expect(() => verifyIntegrity(tarball, integrity)).not.toThrow()
    expect(() => verifyIntegrity(tarball, null)).not.toThrow()
    expect(() => verifyIntegrity(new TextEncoder().encode('evil'), integrity)).toThrow(
      /does not match its integrity/
    )
  })
})
