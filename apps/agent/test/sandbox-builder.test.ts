import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseChecksums, verifyIntegrity } from '../src/builder/sandbox-builder.ts'

describe('sandbox builder', () => {
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
