import { describe, expect, it } from 'vitest'
import { rewritePackageJson } from '../src/scaffolding.ts'
import { githubRepository, releaseRefs } from '../src/upstream.ts'

describe('upstream releases', () => {
  it.each([
    ['git+https://github.com/component/escape-html.git', 'component', 'escape-html'],
    ['https://github.com/lodash/lodash', 'lodash', 'lodash'],
    ['git://github.com/visionmedia/debug.git', 'visionmedia', 'debug'],
    ['git+ssh://git@github.com/acme/tools.git', 'acme', 'tools'],
    ['git@github.com:acme/tools.git', 'acme', 'tools'],
    ['github:sindresorhus/p-limit', 'sindresorhus', 'p-limit'],
    ['jonschlinkert/is-number', 'jonschlinkert', 'is-number'],
    ['https://www.github.com/acme/tools/tree/main/packages/a', 'acme', 'tools'],
    ['https://github.com/acme/tools.js#readme', 'acme', 'tools.js']
  ])('reads the GitHub repository from %s', (url, owner, repo) => {
    expect(githubRepository(url)).toEqual({ owner, repo })
  })

  it.each([
    'git+https://gitlab.com/acme/tools.git',
    'bitbucket:acme/tools',
    'https://example.com/tools.tgz'
  ])('does not treat %s as a GitHub repository', (url) => {
    expect(githubRepository(url)).toBeUndefined()
  })

  it('tries the usual release tag shapes for scoped and unscoped packages', () => {
    expect(releaseRefs('escape-html', '1.0.3')).toEqual([
      'v1.0.3',
      '1.0.3',
      'escape-html@1.0.3',
      'escape-html-v1.0.3'
    ])
    expect(releaseRefs('@acme/strings', '2.1.0')).toEqual([
      'v2.1.0',
      '2.1.0',
      '@acme/strings@2.1.0',
      'strings@2.1.0',
      'strings-v2.1.0'
    ])
  })

  it('keeps the indentation and line endings of package.json when renaming', () => {
    const rewritten = rewritePackageJson('{\r\n\t"name": "foo",\r\n\t"version": "1.0.0"\r\n}', {
      name: '@patchtogo.ai/foo',
      version: '1.0.0-ptg.1',
      repository: { type: 'git', url: 'git+https://github.com/patchtogo-ai/foo.git' }
    })
    expect(rewritten).toBe(
      [
        '{',
        '\t"name": "@patchtogo.ai/foo",',
        '\t"version": "1.0.0-ptg.1",',
        '\t"repository": {',
        '\t\t"type": "git",',
        '\t\t"url": "git+https://github.com/patchtogo-ai/foo.git"',
        '\t},',
        '\t"publishConfig": {',
        '\t\t"access": "public"',
        '\t}',
        '}'
      ].join('\r\n')
    )
  })
})
