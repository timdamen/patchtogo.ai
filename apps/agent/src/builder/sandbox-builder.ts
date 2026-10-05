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
  sandboxDirectories,
  unpackArchive,
  withSandbox,
  type SandboxCredentials,
  type SourceArchive
} from '../sandbox.ts'
import { buildEnv, buildScript } from './build-script.ts'

const buildLayout = {
  ...sandboxDirectories,
  pack: `${sandboxDirectories.io}/pack`,
  published: `${sandboxDirectories.root}/published`,
  built: `${sandboxDirectories.root}/built`
} as const

const files = {
  source: `${buildLayout.io}/source.tgz`,
  published: `${buildLayout.io}/published.tgz`
}

const buildEgress: NetworkPolicy = {
  allow: [NPM_REGISTRY, 'registry.yarnpkg.com', 'repo.yarnpkg.com']
}

const manifestScript = `cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum`

const LOG_LIMIT = 8000

const TIMEOUT_MS = 15 * 60_000

interface SandboxBuilderOptions {
  credentials?: SandboxCredentials
  sourceArchive: SourceArchive
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

async function download(tarball: PublishedVersion['tarball']): Promise<Uint8Array> {
  const response = await fetch(tarball.url)
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

async function build(sandbox: Sandbox, request: BuildRequest, source: Uint8Array) {
  const published = await download(request.tarball)
  await check(sandbox, 'creating directories', 'mkdir', ['-p', ...Object.values(buildLayout)])
  await sandbox.writeFiles([
    { path: files.source, content: source },
    { path: files.published, content: published }
  ])
  const unpack = (archive: string, into: string) =>
    unpackArchive(sandbox, `unpacking ${archive}`, archive, into)
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
    timeoutMs: TIMEOUT_MS - 2 * 60_000
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

export function createSandboxBuilder(options: SandboxBuilderOptions): Builder {
  return {
    async build(request): Promise<BuildResult> {
      const source = await options.sourceArchive(request.source)
      return withSandbox(
        {
          credentials: options.credentials,
          timeoutMs: TIMEOUT_MS,
          networkPolicy: buildEgress,
          purpose: 'tarball-check'
        },
        async (sandbox, seconds) => {
          const result = await build(sandbox, request, source)
          return { ...result, sandboxSeconds: seconds() }
        }
      )
    }
  }
}
