import { posix } from 'node:path'
import { isSandboxPlaceholder } from '@patchtogo/fixer-runner/protocol'
import type { FileChange, FileMode } from './pipeline/ports.ts'

export class DiffError extends Error {
  override name = 'DiffError'
}

type Op = ' ' | '-' | '+'

interface HunkLine {
  op: Op
  text: string
}

interface Hunk {
  oldStart: number
  oldLines: number
  lines: HunkLine[]
}

interface FilePatch {
  oldPath: string | null
  newPath: string | null
  keepOld: boolean
  mode: FileMode | undefined
  hunks: Hunk[]
}

interface PatchHeader {
  gitPaths: [string, string] | undefined
  minus?: string | null
  plus?: string | null
  renameFrom?: string
  renameTo?: string
  copyFrom?: string
  copyTo?: string
  created: boolean
  deleted: boolean
  mode?: string
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92
}

const FILE_MODES = new Set<string>(['100644', '100755'])

function unquote(value: string): string {
  if (!value.startsWith('"')) return value
  if (value.length < 2 || !value.endsWith('"')) throw new DiffError(`bad quoted path ${value}`)
  const bytes: number[] = []
  const body = value.slice(1, -1)
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? ''
    if (char !== '\\') {
      bytes.push(...Buffer.from(char))
      continue
    }
    const next = body[++i] ?? ''
    const escaped = ESCAPES[next]
    if (escaped !== undefined) {
      bytes.push(escaped)
    } else if (/^[0-7]{3}$/.test(body.slice(i, i + 3))) {
      bytes.push(Number.parseInt(body.slice(i, i + 3), 8))
      i += 2
    } else {
      throw new DiffError(`bad escape in quoted path ${value}`)
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

function quotedToken(text: string): [string, string] {
  let end = 1
  while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
  return [text.slice(0, end + 1), text.slice(end + 2)]
}

function withoutPrefix(path: string, prefix: 'a/' | 'b/'): string {
  if (!path.startsWith(prefix)) throw new DiffError(`path ${path} lacks the ${prefix} prefix`)
  return path.slice(prefix.length)
}

function gitHeaderPaths(rest: string): [string, string] | undefined {
  if (rest.startsWith('"')) {
    const [first, second] = quotedToken(rest)
    return [withoutPrefix(unquote(first), 'a/'), withoutPrefix(unquote(second), 'b/')]
  }
  const quotedSecond = rest.indexOf(' "b/')
  if (quotedSecond !== -1) {
    return [
      withoutPrefix(rest.slice(0, quotedSecond), 'a/'),
      withoutPrefix(unquote(rest.slice(quotedSecond + 1)), 'b/')
    ]
  }
  const length = (rest.length - 5) / 2
  const path = rest.slice(2, 2 + length)
  return rest === `a/${path} b/${path}` ? [path, path] : undefined
}

function markerPath(value: string, prefix: 'a/' | 'b/'): string | null {
  const path = value.split('\t')[0] ?? ''
  if (path === '/dev/null') return null
  return withoutPrefix(unquote(path), prefix)
}

function readHeader(lines: string[], start: number): { header: PatchHeader; next: number } {
  const header: PatchHeader = {
    gitPaths: gitHeaderPaths((lines[start] ?? '').slice('diff --git '.length)),
    created: false,
    deleted: false
  }
  let i = start + 1
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.startsWith('diff --git ') || line.startsWith('@@')) break
    if (line.startsWith('--- ')) header.minus = markerPath(line.slice(4), 'a/')
    else if (line.startsWith('+++ ')) header.plus = markerPath(line.slice(4), 'b/')
    else if (line.startsWith('new file mode ')) {
      header.created = true
      header.mode = line.slice('new file mode '.length)
    } else if (line.startsWith('deleted file mode ')) header.deleted = true
    else if (line.startsWith('new mode ')) header.mode = line.slice('new mode '.length)
    else if (line.startsWith('old mode ')) continue
    else if (line.startsWith('rename from ')) header.renameFrom = unquote(line.slice(12))
    else if (line.startsWith('rename to ')) header.renameTo = unquote(line.slice(10))
    else if (line.startsWith('copy from ')) header.copyFrom = unquote(line.slice(10))
    else if (line.startsWith('copy to ')) header.copyTo = unquote(line.slice(8))
    else if (/^(dis)?similarity index \d+%$/.test(line)) continue
    else if (line.startsWith('index ')) {
      const mode = /^index [0-9a-f]+\.\.[0-9a-f]+(?: (\d{6}))?$/.exec(line)
      if (!mode) throw new DiffError(`unrecognised index line: ${line}`)
      if (mode[1]) header.mode = mode[1]
    } else if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
      throw new DiffError('the diff contains a binary change')
    } else {
      throw new DiffError(`unrecognised diff header line: ${line}`)
    }
  }
  return { header, next: i }
}

function readHunk(lines: string[], start: number): { hunk: Hunk; next: number } {
  const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[start] ?? '')
  if (!range) throw new DiffError(`bad hunk header: ${lines[start]}`)
  const hunk: Hunk = {
    oldStart: Number(range[1]),
    oldLines: range[2] === undefined ? 1 : Number(range[2]),
    lines: []
  }
  let oldLeft = hunk.oldLines
  let newLeft = range[4] === undefined ? 1 : Number(range[4])
  let i = start + 1
  const noNewline = () => {
    const last = hunk.lines.at(-1)
    if (!last) throw new DiffError('a "no newline" marker without a line')
    last.text = last.text.slice(0, -1)
  }
  while (oldLeft > 0 || newLeft > 0) {
    if (i >= lines.length) throw new DiffError('the diff ends inside a hunk')
    const line = lines[i++] ?? ''
    if (line.startsWith('\\')) {
      noNewline()
      continue
    }
    const op = (line === '' ? ' ' : line[0]) as Op
    if (op === ' ') {
      oldLeft--
      newLeft--
    } else if (op === '-') oldLeft--
    else if (op === '+') newLeft--
    else throw new DiffError(`bad hunk line: ${line}`)
    if (oldLeft < 0 || newLeft < 0) throw new DiffError('a hunk is longer than its header says')
    hunk.lines.push({ op, text: `${line.slice(1)}\n` })
  }
  while (lines[i]?.startsWith('\\')) {
    noNewline()
    i++
  }
  return { hunk, next: i }
}

function fileMode(mode: string | undefined, path: string): FileMode | undefined {
  if (mode === undefined) return undefined
  if (!FILE_MODES.has(mode)) {
    throw new DiffError(`${path} would get mode ${mode}; only regular files are allowed`)
  }
  return mode as FileMode
}

function toPatch(header: PatchHeader, hunks: Hunk[]): FilePatch {
  const [gitOld, gitNew] = header.gitPaths ?? []
  const oldPath = header.created
    ? null
    : (header.renameFrom ?? header.copyFrom ?? header.minus ?? gitOld ?? null)
  const newPath = header.deleted
    ? null
    : (header.renameTo ?? header.copyTo ?? header.plus ?? gitNew ?? null)
  const path = newPath ?? oldPath
  if (path === null) throw new DiffError('a diff entry names no file')
  return {
    oldPath,
    newPath,
    keepOld: header.copyFrom !== undefined,
    mode: newPath === null ? undefined : fileMode(header.mode, path),
    hunks
  }
}

function parseDiff(diff: string): FilePatch[] {
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const patches: FilePatch[] = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i]?.startsWith('diff --git ')) {
      throw new DiffError(`expected a "diff --git" line, found: ${lines[i]}`)
    }
    const read = readHeader(lines, i)
    i = read.next
    const hunks: Hunk[] = []
    while (lines[i]?.startsWith('@@')) {
      const { hunk, next } = readHunk(lines, i)
      hunks.push(hunk)
      i = next
    }
    patches.push(toPatch(read.header, hunks))
  }
  return patches
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function applyHunks(original: string, hunks: Hunk[], path: string): string {
  const source = splitLines(original)
  const out: string[] = []
  let position = 0
  for (const hunk of hunks) {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1
    if (start < position || start > source.length) {
      throw new DiffError(`${path}: the hunk at line ${hunk.oldStart} is out of order or range`)
    }
    out.push(...source.slice(position, start))
    position = start
    for (const { op, text } of hunk.lines) {
      if (op === '+') {
        out.push(text)
        continue
      }
      if (source[position] !== text) {
        throw new DiffError(`${path}: the hunk at line ${hunk.oldStart} does not match the base`)
      }
      if (op === ' ') out.push(text)
      position++
    }
  }
  out.push(...source.slice(position))
  return out.join('')
}

function checkPath(path: string): void {
  const segments = path.split('/')
  if (
    path.includes('\0') ||
    posix.isAbsolute(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new DiffError(`the diff names an invalid path: ${JSON.stringify(path)}`)
  }
  if (
    segments[0] === '.github' ||
    segments.includes('.git') ||
    segments.at(-1) === 'PATCHTOGO.md'
  ) {
    throw new DiffError(`the diff changes ${path}, which belongs to the scaffolding`)
  }
}

export async function diffChanges(
  diff: string,
  read: (path: string) => Promise<string | undefined>
): Promise<FileChange[]> {
  const changes = new Map<string, FileChange>()
  const add = (change: FileChange) => {
    if (changes.has(change.path)) throw new DiffError(`the diff changes ${change.path} twice`)
    changes.set(change.path, change)
  }
  for (const patch of parseDiff(diff)) {
    const { oldPath, newPath } = patch
    for (const path of [oldPath, newPath]) if (path !== null) checkPath(path)
    const original = oldPath === null ? '' : await read(oldPath)
    if (original === undefined) throw new DiffError(`${oldPath} does not exist on the base`)
    if (newPath === null) {
      add({ path: oldPath ?? '', delete: true })
      continue
    }
    const content = applyHunks(original, patch.hunks, newPath)
    if (oldPath === null && content === '' && isSandboxPlaceholder(newPath)) {
      throw new DiffError(
        `the diff adds an empty ${newPath}, a placeholder that Claude Code's sandbox leaves behind`
      )
    }
    add(patch.mode ? { path: newPath, content, mode: patch.mode } : { path: newPath, content })
    if (oldPath !== null && oldPath !== newPath && !patch.keepOld) {
      add({ path: oldPath, delete: true })
    }
  }
  return [...changes.values()]
}
