import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { parseSync } from 'oxc-parser'

const CODE_EXT = /\.(?:[cm]?[jt]s|tsx|jsx)$/
const SKIP = /(?:^|\/)(?:node_modules|dist|build|\.vitepress\/cache)\/|\.example\.|\.d\.ts$/
const DIRECTIVE =
  /^\s*(?:\/\/\/\s*<reference|@ts-(?:ignore|expect-error|nocheck|check)\b|oxlint-|eslint-|oxfmt-|prettier-|@vite-ignore|v8 ignore|c8 ignore)/

const fix = process.argv.includes('--fix')
const args = process.argv.slice(2).filter((a) => a !== '--fix')
const files = (
  args.length
    ? args
    : execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
).filter((f) => (CODE_EXT.test(f) || f.endsWith('.vue')) && !SKIP.test(f))

function scriptComments(source, filename, offset = 0) {
  const { comments } = parseSync(filename, source, {
    lang: filename.endsWith('.vue.ts') ? 'ts' : undefined
  })
  return comments.map((c) => ({ start: c.start + offset, end: c.end + offset, text: c.value }))
}

function vueComments(source) {
  const found = []
  for (const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const bodyStart = m.index + m[0].indexOf(m[1])
    found.push(...scriptComments(m[1], 'component.vue.ts', bodyStart))
  }
  for (const m of source.matchAll(/<!--([\s\S]*?)-->/g)) {
    found.push({ start: m.index, end: m.index + m[0].length, text: m[1] })
  }
  return found.toSorted((a, b) => a.start - b.start)
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

function stripSpans(source, spans) {
  let out = source
  for (const span of spans.toSorted((a, b) => b.start - a.start)) {
    const lineStart = out.lastIndexOf('\n', span.start - 1) + 1
    const lineEnd = out.indexOf('\n', span.end)
    const before = out.slice(lineStart, span.start)
    const after = out.slice(span.end, lineEnd === -1 ? out.length : lineEnd)
    const wholeLines = before.trim() === '' && after.trim() === ''
    out = wholeLines
      ? out.slice(0, lineStart) + out.slice(lineEnd === -1 ? out.length : lineEnd + 1)
      : out.slice(0, span.start) + out.slice(span.end).replace(/^[ \t]+(?=\r?\n|$)/, '')
  }
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
}

let offending = 0
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const spans = (file.endsWith('.vue') ? vueComments(source) : scriptComments(source, file)).filter(
    (c) => !DIRECTIVE.test(c.text)
  )
  if (spans.length === 0) continue
  if (fix) {
    writeFileSync(file, stripSpans(source, spans))
    console.log(`fixed ${file}: removed ${spans.length} comment(s)`)
    continue
  }
  offending += spans.length
  for (const c of spans) {
    console.log(`${file}:${lineOf(source, c.start)}: ${c.text.trim().split('\n')[0].slice(0, 80)}`)
  }
}

if (offending > 0) {
  console.error(
    `\n${offending} comment(s) found. Code explains itself; move the why into docs/ or a commit message.`
  )
  process.exit(1)
}
