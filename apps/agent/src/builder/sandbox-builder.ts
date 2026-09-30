import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { NetworkPolicy, Sandbox } from '@vercel/sandbox'
import type {
  Builder,
  BuildRequest,
  BuildResult,
  PackageFiles,
  PublishedVersion
} from '../pipeline/ports.ts'
import {
  check,
  NPM_REGISTRY,
  openSandbox,
  type SandboxCredentials,
  type SourceArchive
} from '../sandbox.ts'
import { buildEnv, buildScript } from './build-script.ts'

export const buildLayout = {
  root: '/vercel/ptg',
  io: '/vercel/ptg/io',
  pack: '/vercel/ptg/io/pack',
  work: '/vercel/ptg/work',
  published: '/vercel/ptg/published',
  built: '/vercel/ptg/built'
} as const

const files = {
  source: `${buildLayout.io}/source.tgz`,
  published: `${buildLayout.io}/published.tgz`
}

export const buildEgress: NetworkPolicy = {
  allow: [NPM_REGISTRY, 'registry.yarnpkg.com', 'repo.yarnpkg.com']
}

const manifestScript = `cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum`

const LOG_LIMIT = 8000

export interface SandboxBuilderOptions {
  credentials?: SandboxCredentials
  sourceArchive: SourceArchive
  timeoutMs?: number
  vcpus?: number
  fetch?: typeof fetch
  now?: () => Date
}

export function parseChecksums(output: string): Record<string, string> {
  const hashes: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    if (match?.[1] && match[2]) hashes[posix.normalize(match[2])] = match[1]
  }
  return hashes
}

export function verifyIntegrity(tarball: Uint8Array, integrity: string | null): void {
  if (!integrity) return
  const expected = integrity
    .split(/\s+/)
    .filter((entry) => entry.startsWith('sha512-'))
    .map((entry) => entry.slice('sha512-'.length))
  if (expected.length === 0) return
  const actual = createHash('sha512').update(tarball).digest('base64')
  if (!expected.includes(actual)) {
    throw new Error(`the npm tarball does not match its integrity ${integrity}`)
  }
}

async function download(
  tarball: PublishedVersion['tarball'],
  fetchImpl: typeof fetch
): Promise<Uint8Array> {
  const response = await fetchImpl(tarball.url)
  if (!response.ok) throw new Error(`${tarball.url}: HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  verifyIntegrity(bytes, tarball.integrity)
  return bytes
}

async function packageFiles(sandbox: Sandbox, directory: string): Promise<PackageFiles> {
  const checksums = await check(sandbox, 'hashing package files', 'bash', [
    '-c',
    manifestScript,
    'manifest',
    directory
  ])
  const packageJson = await sandbox.readFileToBuffer({ path: `${directory}/package.json` })
  let parsed: unknown = null
  try {
    parsed = packageJson ? JSON.parse(packageJson.toString('utf8')) : null
  } catch {
    parsed = null
  }
  return { files: parseChecksums(checksums), packageJson: parsed }
}

export function createSandboxBuilder(options: SandboxBuilderOptions): Builder {
  const timeoutMs = options.timeoutMs ?? 15 * 60_000
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())

  async function build(sandbox: Sandbox, request: BuildRequest, source: Uint8Array) {
    const published = await download(request.tarball, fetchImpl)
    await check(sandbox, 'creating directories', 'mkdir', ['-p', ...Object.values(buildLayout)])
    await sandbox.writeFiles([
      { path: files.source, content: source },
      { path: files.published, content: published }
    ])
    const unpack = (archive: string, into: string) =>
      check(sandbox, `unpacking ${archive}`, 'tar', [
        '-xzf',
        archive,
        '-C',
        into,
        '--strip-components=1',
        '--no-same-owner'
      ])
    await unpack(files.published, buildLayout.published)
    const publishedFiles = await packageFiles(sandbox, buildLayout.published)
    await unpack(files.source, buildLayout.work)
    const done = await sandbox.runCommand({
      cmd: 'bash',
      args: [
        '-c',
        buildScript,
        'build',
        posix.join(buildLayout.work, request.directory),
        buildLayout.pack,
        request.publishedAt ?? ''
      ],
      cwd: buildLayout.work,
      env: buildEnv,
      timeoutMs: timeoutMs - 2 * 60_000
    })
    const log = (await done.output('both')).slice(-LOG_LIMIT)
    if (done.exitCode !== 0) {
      return { published: publishedFiles, built: null, log: `exit ${done.exitCode}\n${log}` }
    }
    await check(sandbox, 'unpacking the built package', 'bash', [
      '-c',
      'tar -xzf "$1"/*.tgz -C "$2" --strip-components=1 --no-same-owner',
      'unpack',
      buildLayout.pack,
      buildLayout.built
    ])
    return {
      published: publishedFiles,
      built: await packageFiles(sandbox, buildLayout.built),
      log
    }
  }

  return {
    async build(request): Promise<BuildResult> {
      const source = await options.sourceArchive(request.source)
      const started = now().getTime()
      let sandbox: Sandbox | undefined
      try {
        sandbox = await openSandbox({
          credentials: options.credentials,
          timeoutMs,
          vcpus: options.vcpus,
          networkPolicy: buildEgress,
          purpose: 'tarball-check'
        })
        const result = await build(sandbox, request, source)
        return { ...result, sandboxSeconds: Math.round((now().getTime() - started) / 1000) }
      } finally {
        await sandbox?.stop().catch(() => undefined)
      }
    }
  }
}
