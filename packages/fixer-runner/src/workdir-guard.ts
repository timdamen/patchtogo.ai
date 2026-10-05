import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'

export const writeTools = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

export async function resolveReal(target: string): Promise<string> {
  const missing: string[] = []
  let current = path.resolve(target)
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.toReversed())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) return path.join(current, ...missing.toReversed())
      missing.push(path.basename(current))
      current = parent
    }
  }
}

function targetPath(toolInput: unknown): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined
  const { file_path: filePath, notebook_path: notebookPath } = toolInput as Record<string, unknown>
  if (typeof filePath === 'string') return filePath
  if (typeof notebookPath === 'string') return notebookPath
  return undefined
}

export function workdirGuard(workdir: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const target = targetPath(input.tool_input)
    if (target === undefined) return {}
    const [resolved, root] = await Promise.all([
      resolveReal(path.resolve(input.cwd, target)),
      resolveReal(workdir)
    ])
    if (isInside(resolved, root)) return {}
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Writes are limited to the package working directory ${workdir}.`
      }
    }
  }
}
