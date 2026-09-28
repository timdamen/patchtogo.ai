import { Sandbox, type NetworkPolicy } from '@vercel/sandbox'
import type { FixRequest } from './pipeline/ports.ts'

export const NPM_REGISTRY = 'registry.npmjs.org'

export interface SandboxCredentials {
  teamId: string
  projectId: string
  token: string
}

export type SourceArchive = (source: FixRequest['source']) => Promise<Uint8Array>

export interface OpenSandboxOptions {
  credentials?: SandboxCredentials
  timeoutMs: number
  vcpus?: number
  networkPolicy: NetworkPolicy
  purpose: string
}

export function openSandbox(options: OpenSandboxOptions): Promise<Sandbox> {
  return Sandbox.create({
    ...options.credentials,
    persistent: false,
    timeout: options.timeoutMs,
    resources: { vcpus: options.vcpus ?? 2 },
    networkPolicy: options.networkPolicy,
    tags: { app: 'patchtogo', purpose: options.purpose }
  })
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
