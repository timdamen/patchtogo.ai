import { mkdtemp, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { isInside, workdirGuard } from '../src/workdir-guard.ts'

let root: string
let workdir: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ptg-guard-'))
  workdir = path.join(root, 'work')
  await mkdir(path.join(workdir, 'lib'), { recursive: true })
  await symlink(root, path.join(workdir, 'escape'))
})

async function decide(toolName: string, toolInput: Record<string, unknown>) {
  const hook = workdirGuard(workdir)
  const output = await hook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'toolu_1',
      session_id: 's',
      transcript_path: '/t',
      cwd: workdir
    },
    'toolu_1',
    { signal: new AbortController().signal }
  )
  return 'hookSpecificOutput' in output && output.hookSpecificOutput?.hookEventName === 'PreToolUse'
    ? output.hookSpecificOutput.permissionDecision
    : 'no opinion'
}

describe('workdir guard', () => {
  it('lets writes inside the working directory through, including new directories', async () => {
    expect(await decide('Write', { file_path: path.join(workdir, 'lib', 'new', 'a.js') })).toBe(
      'no opinion'
    )
    expect(await decide('Edit', { file_path: 'lib/index.js' })).toBe('no opinion')
  })

  it('denies writes outside the working directory', async () => {
    expect(await decide('Write', { file_path: path.join(root, 'runner', 'main.ts') })).toBe('deny')
    expect(await decide('Edit', { file_path: '../runner/main.ts' })).toBe('deny')
    expect(await decide('NotebookEdit', { notebook_path: '/tmp/x.ipynb' })).toBe('deny')
  })

  it('follows symlinks that point out of the working directory', async () => {
    expect(await decide('Write', { file_path: path.join(workdir, 'escape', 'x.js') })).toBe('deny')
  })

  it('treats sibling directories with a common prefix as outside', () => {
    expect(isInside('/work-evil/a', '/work')).toBe(false)
    expect(isInside('/work/..data/a', '/work')).toBe(true)
    expect(isInside('/work', '/work')).toBe(true)
  })
})
