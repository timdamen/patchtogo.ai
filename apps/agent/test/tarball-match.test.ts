import { describe, expect, it } from 'vitest'
import type { PackageFiles } from '../src/pipeline/ports.ts'
import { compareTarballs, describeMismatch } from '../src/tarball-match.ts'

const published: PackageFiles = {
  files: { 'package.json': 'p1', 'index.js': 'i1', 'Readme.md': 'r1', LICENSE: 'l1' },
  packageJson: {
    name: 'escape-html',
    version: '1.0.3',
    main: 'index.js',
    bin: './cli.js',
    _npmVersion: '1.4.28',
    gitHead: 'abc',
    scripts: { test: 'mocha' }
  }
}

describe('tarball-match check', () => {
  it('matches a build with the same files and the same runtime package.json', () => {
    const built: PackageFiles = {
      files: { ...published.files, 'package.json': 'p2', 'extra.d.ts': 'x' },
      packageJson: {
        name: 'escape-html',
        version: '1.0.3',
        main: './index.js',
        bin: { 'escape-html': 'cli.js' },
        scripts: { test: 'node --test' },
        devDependencies: { mocha: '1' }
      }
    }

    expect(compareTarballs(published, built)).toEqual({
      matches: true,
      missing: [],
      differing: [],
      extra: ['extra.d.ts']
    })
  })

  it('reports missing and differing files and runtime package.json fields', () => {
    const built: PackageFiles = {
      files: { 'package.json': 'p1', 'index.js': 'i2', 'Readme.md': 'r1' },
      packageJson: {
        ...(published.packageJson as object),
        exports: './index.js',
        dependencies: { 'left-pad': '1' }
      }
    }

    const comparison = compareTarballs(published, built)

    expect(comparison).toEqual({
      matches: false,
      missing: ['LICENSE'],
      differing: ['package.json (exports, dependencies)', 'index.js'],
      extra: []
    })
    expect(describeMismatch(comparison)).toBe(
      '2 differ (package.json (exports, dependencies), index.js); 1 missing from the build (LICENSE)'
    )
  })

  it('shortens long lists of differences', () => {
    const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}.js`, 'a']))
    const comparison = compareTarballs({ files, packageJson: {} }, { files: {}, packageJson: {} })
    expect(describeMismatch(comparison)).toBe(
      '7 missing from the build (f0.js, f1.js, f2.js, f3.js, f4.js, ...)'
    )
  })
})
