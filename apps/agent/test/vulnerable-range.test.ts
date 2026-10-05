import { describe, expect, it } from 'vitest'
import { parseVulnerableRange } from '../src/vulnerable-range.ts'

function includes(range: string, version: string): boolean | undefined {
  return parseVulnerableRange(range)?.includes(version)
}

describe('GitHub vulnerable ranges', () => {
  it.each([
    ['>= 3.7.0, < 4.17.19', '3.7.0', true],
    ['>= 3.7.0, < 4.17.19', '4.17.18', true],
    ['>= 3.7.0, < 4.17.19', '4.17.19', false],
    ['>= 3.7.0, < 4.17.19', '3.6.9', false],
    ['>= 3.7.0, < 4.17.19', '4.0.0-beta.1', true],
    ['<= 4.3.2', '4.3.2', true],
    ['<= 4.3.2', '4.3.3', false],
    ['< 1.2.9', '1.2.9-rc.1', true],
    ['= 1.2.9', '1.2.9', true],
    ['= 1.2.9', '1.2.10', false],
    ['> 1.0.0', '1.0.1', true],
    ['>= 15.0.0-canary.0, <= 15.0.0-canary.205', '15.0.0-canary.100', true],
    ['>= 15.0.0-canary.0, <= 15.0.0-canary.205', '15.0.0-canary.206', false],
    ['>= 15.0.0-canary.0, <= 15.0.0-canary.205', '15.0.0', false],
    ['< 1.15.47-nightly-20260729.1', '1.15.47-nightly-20260728.3', true],
    ['>= 0', '0.0.1', true],
    ['> 0', '0.0.1', true],
    ['> 0', '0.0.0', false],
    ['< 1.2', '1.1.9', true],
    ['< 1.2', '1.2.0', false],
    ['<= 0.0.125', '0.34.6', false]
  ])('%s includes %s: %s', (range, version, expected) => {
    expect(includes(range, version)).toBe(expected)
  })

  it.each([
    '',
    '*',
    '1.2.3',
    '>= 1.0.0 < 2.0.0',
    '>= 1.0.0 || < 0.5.0',
    '^1.2.3',
    '~> 1.2',
    '< 1.x',
    '>= 1.0.0,',
    'not a range'
  ])('does not guess at %j', (range) => {
    expect(parseVulnerableRange(range)).toBeUndefined()
  })

  it.each([
    ['<= 1.0.3', '1.0.3'],
    ['>= 1.0.0, < 2.0.0', '1.0.3'],
    ['= 1.0.0', '1.0.0'],
    ['>= 0', '2.0.0'],
    ['>= 1.1.0-alpha.0, < 1.2.0', '1.1.0-beta.1'],
    ['>= 3.0.0', undefined]
  ])('picks the latest version in %s, preferring stable releases', (range, expected) => {
    const versions = ['0.9.0', '1.0.0', '1.0.3', '1.1.0-beta.1', '2.0.0', 'not-semver']
    expect(parseVulnerableRange(range)?.latest(versions)).toBe(expected)
  })
})
