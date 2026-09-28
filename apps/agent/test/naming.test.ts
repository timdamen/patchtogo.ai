import { describe, expect, it } from 'vitest'
import { baseBranchName, packageSlug, patchedPackageName, patchedVersion } from '../src/naming.ts'

const settings = { npmScope: 'patchtogo.ai' }

describe('naming', () => {
  it.each([
    ['escape-html', '@patchtogo.ai/escape-html'],
    ['lodash.set', '@patchtogo.ai/lodash.set'],
    ['@babel/traverse', '@patchtogo.ai/babel__traverse'],
    ['@types/node', '@patchtogo.ai/types__node']
  ])('publishes %s as %s', (name, patched) => {
    expect(patchedPackageName(name, settings)).toBe(patched)
  })

  it('takes the npm scope from the settings', () => {
    expect(patchedPackageName('@acme/strings', { npmScope: 'patchtogo' })).toBe(
      '@patchtogo/acme__strings'
    )
  })

  it('lowercases legacy package names and replaces characters repositories and refs reject', () => {
    expect(packageSlug('JSONStream')).toBe('jsonstream')
    expect(packageSlug("ima(ge)!'s~*")).toBe('ima-ge---s--')
  })

  it.each([
    ['1.0.3', 1, '1.0.3-ptg.1'],
    ['4.17.21', 2, '4.17.21-ptg.2'],
    ['2.0.0-beta.3', 1, '2.0.0-beta.3-ptg.1']
  ])('versions %s release %i as %s', (version, release, patched) => {
    expect(patchedVersion(version, release)).toBe(patched)
  })

  it('cuts one base branch per package and upstream version', () => {
    expect(baseBranchName('escape-html', '1.0.3')).toBe('ptg/base/escape-html/1.0.3')
    expect(baseBranchName('@acme/strings', '2.1.0')).toBe('ptg/base/acme__strings/2.1.0')
  })
})
