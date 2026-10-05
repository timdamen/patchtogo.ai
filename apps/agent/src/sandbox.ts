import { Sandbox, type NetworkPolicy } from '@vercel/sandbox'
import type { FixRequest } from './pipeline/ports.ts'

export const NPM_REGISTRY = 'registry.npmjs.org'

const root = '/vercel/ptg'

export const sandboxDirectories = {
  root,
  io: `${root}/io`,
  work: `${root}/work`
} as const

export interface SandboxCredentials {
  teamId: string
  projectId: string
  token: string
}

export type SourceArchive = (source: FixRequest['source']) => Promise<Uint8Array>

export interface OpenSandboxOptions {
  credentials?: SandboxCredentials
  timeoutMs: number
  networkPolicy: NetworkPolicy
  purpose: string
}

export async function withSandbox<T>(
  options: OpenSandboxOptions,
  use: (sandbox: Sandbox, seconds: () => number) => Promise<T>
): Promise<T> {
  const started = Date.now()
  let sandbox: Sandbox | undefined
  try {
    sandbox = await Sandbox.create({
      ...options.credentials,
      persistent: false,
      timeout: options.timeoutMs,
      resources: { vcpus: 2 },
      networkPolicy: options.networkPolicy,
      tags: { app: 'patchtogo', purpose: options.purpose }
    })
    return await use(sandbox, () => Math.round((Date.now() - started) / 1000))
  } finally {
    await sandbox?.stop().catch(() => undefined)
  }
}

export async function check(
  sandbox: Sandbox,
  what: string,
  cmd: string,
  args: string[],
  cwd?: string
): Promise<string> {
  const done = await sandbox.runCommand({ cmd, args, cwd })
  if (done.exitCode !== 0) {
    const output = (await done.output('both')).slice(-4000)
    throw new Error(`${what} failed in the sandbox (exit ${done.exitCode}):\n${output}`)
  }
  return done.stdout()
}

export function unpackArchive(
  sandbox: Sandbox,
  what: string,
  archive: string,
  into: string
): Promise<string> {
  return check(sandbox, what, 'tar', [
    '-xzf',
    archive,
    '-C',
    into,
    '--strip-components=1',
    '--no-same-owner'
  ])
}
