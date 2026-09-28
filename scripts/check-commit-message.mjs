import { readFileSync } from 'node:fs'

const TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert'
]
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()]*)\))?!?: (?<subject>.*)$/
const SCOPE = /^[a-z0-9][a-z0-9./-]*$/
const EXEMPT = /^(?:Merge |Revert "|fixup! |squash! |amend! )/
const SCISSORS = /^# -+ >8 -+$/m
const MAX_HEADER = 72

const [file] = process.argv.slice(2)
if (!file) {
  console.error('usage: node scripts/check-commit-message.mjs <commit-message-file>')
  process.exit(2)
}

const lines = readFileSync(file, 'utf8')
  .split(SCISSORS)[0]
  .split('\n')
  .filter((line) => !line.startsWith('#'))
while (lines.length > 0 && lines[0].trim() === '') lines.shift()
const [header = '', ...body] = lines

if (header.trim() === '' || EXEMPT.test(header)) process.exit(0)

const problems = []
const match = HEADER.exec(header)
if (match) {
  const { type, scope, subject } = match.groups
  if (!TYPES.includes(type)) problems.push(`type "${type}" is not one of: ${TYPES.join(', ')}`)
  if (scope !== undefined && !SCOPE.test(scope)) {
    problems.push(`scope "${scope}" must be lowercase letters, digits, dots, slashes or dashes`)
  }
  if (subject.trim() === '') problems.push('subject is empty')
  if (/^[A-Z]/.test(subject)) problems.push('subject starts with a capital letter')
  if (subject.endsWith('.')) problems.push('subject ends with a period')
} else {
  problems.push('header must look like "type(scope): subject" or "type: subject"')
}
if (header.length > MAX_HEADER) {
  problems.push(`header is ${header.length} characters, at most ${MAX_HEADER} allowed`)
}
if (body.length > 0 && body[0].trim() !== '') {
  problems.push('leave a blank line between the header and the body')
}

if (problems.length > 0) {
  console.error(`commit message rejected:\n  ${header}\n`)
  for (const problem of problems) console.error(`- ${problem}`)
  console.error(
    '\nConventional Commits: type(scope): subject, e.g. "feat(agent): triage advisories"'
  )
  process.exit(1)
}
