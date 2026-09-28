import { posix } from 'node:path'
import { patchedPackageName, patchedVersion } from './naming.ts'
import type { UpstreamRelease } from './pipeline/patch-run.ts'
import type { FileChange, RepoRef } from './pipeline/ports.ts'
import { repoName } from './upstream.ts'

export const NOTICE_FILE = 'PATCHTOGO.md'
export const CODEOWNERS_FILE = '.github/CODEOWNERS'
export const WORKFLOWS_DIRECTORY = '.github/workflows'

export interface ScaffoldingSettings {
  npmScope: string
  reviewerTeam: string
}

export interface ScaffoldingInput {
  packageName: string
  release: UpstreamRelease
  fork: RepoRef
  packageJson: string
  directoryFiles: string[]
  readme: { path: string; text: string } | null
  workflowFiles: string[]
  settings: ScaffoldingSettings
}

export interface Scaffolding {
  message: string
  changes: FileChange[]
}

const readmePattern = /^readme(\.(md|markdown|txt))?$/i
const licensePattern = /^(licen[cs]e|copying)(\.[a-z]+)?$/i

export function findReadme(files: string[]): string | undefined {
  return files.filter((file) => readmePattern.test(posix.basename(file))).toSorted()[0]
}

function findLicense(files: string[]): string | undefined {
  const license = files.filter((file) => licensePattern.test(posix.basename(file))).toSorted()[0]
  return license && posix.basename(license)
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

function jsonLayout(text: string) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const indent = /^[{[]\r?\n([ \t]+)\S/.exec(text)?.[1] ?? '  '
  return { newline, indent, trailing: /\r?\n$/.test(text) ? newline : '' }
}

export function rewritePackageJson(
  text: string,
  changes: { name: string; version: string; repository: Record<string, string> }
): string {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('package.json is not a JSON object')
  }
  const pkg = { ...(parsed as Record<string, unknown>) }
  pkg.name = changes.name
  pkg.version = changes.version
  pkg.repository = changes.repository
  pkg.publishConfig = { access: 'public' }
  if (Array.isArray(pkg.files) && !pkg.files.includes(NOTICE_FILE)) {
    pkg.files = [...pkg.files, NOTICE_FILE]
  }
  const { newline, indent, trailing } = jsonLayout(text)
  return JSON.stringify(pkg, null, indent).replaceAll('\n', newline) + trailing
}

function banner(input: ScaffoldingInput, patchedName: string, markdown: boolean): string {
  const { packageName, release } = input
  const upstream = `https://github.com/${repoName(release.repository)}`
  const npm = `https://www.npmjs.com/package/${packageName}`
  const licence = release.license ? `, under its original licence (${release.license})` : ''
  if (!markdown) {
    return [
      `UNOFFICIAL PATCHED FORK: ${patchedName} is ${packageName} ${release.version} with security fixes`,
      `from patchtogo (https://patchtogo.ai)${licence}. It is not maintained by or affiliated with`,
      `the upstream authors. Upstream: ${upstream}. See ${NOTICE_FILE} for attribution.`
    ].join('\n')
  }
  return [
    '> [!WARNING]',
    `> **Unofficial patched fork.** \`${patchedName}\` is [\`${packageName}\`](${npm}) ${release.version} with security fixes from [patchtogo](https://patchtogo.ai)${licence}.`,
    `> It is not maintained by or affiliated with the upstream authors. The original lives at ${upstream}; see [${NOTICE_FILE}](${NOTICE_FILE}) for attribution.`
  ].join('\n')
}

function revision({ commit }: UpstreamRelease): string {
  return commit.ref === commit.sha ? `\`${commit.sha}\`` : `\`${commit.ref}\` (${commit.sha})`
}

function notice(input: ScaffoldingInput, patchedName: string, license: string | undefined) {
  const { packageName, release, fork } = input
  const licence = release.license ?? 'the upstream licence'
  const licenceText = license
    ? `The upstream licence text is in [${license}](${license}).`
    : 'The upstream package ships no licence file; its licence is declared in package.json.'
  return [
    `# About ${patchedName}`,
    '',
    `\`${patchedName}\` is an unofficial fork of the npm package \`${packageName}\`, version ${release.version}, republished by [patchtogo](https://patchtogo.ai) with security fixes. patchtogo is not affiliated with the upstream authors, and all credit for the original code goes to them.`,
    '',
    `- Upstream package: https://www.npmjs.com/package/${packageName}`,
    `- Upstream source: https://github.com/${repoName(release.repository)} at ${revision(release)}`,
    `- This fork: https://github.com/${repoName(fork)}`,
    '',
    `## Licence`,
    '',
    `The package keeps its original licence, ${licence}. ${licenceText} patchtogo's changes are released under the same licence.`,
    '',
    `Every change patchtogo made on top of the upstream release is a public, reviewed pull request in this fork.`,
    ''
  ].join('\n')
}

export function scaffolding(input: ScaffoldingInput): Scaffolding {
  const { packageName, release, fork, settings } = input
  const directory = release.directory
  const at = (file: string) => posix.join(directory || '.', file)
  const patchedName = patchedPackageName(packageName, settings)
  const version = patchedVersion(release.version, 1)
  const packageJson = rewritePackageJson(input.packageJson, {
    name: patchedName,
    version,
    repository: {
      type: 'git',
      url: `git+https://github.com/${repoName(fork)}.git`,
      ...(directory ? { directory } : {})
    }
  })
  const readmePath = input.readme?.path ?? at('README.md')
  const markdown = isMarkdown(readmePath)
  const readme = `${banner(input, patchedName, markdown)}\n\n${input.readme?.text ?? `# ${patchedName}\n`}`
  const changes: FileChange[] = [
    { path: at('package.json'), content: packageJson },
    { path: readmePath, content: readme },
    {
      path: at(NOTICE_FILE),
      content: notice(input, patchedName, findLicense(input.directoryFiles))
    },
    { path: CODEOWNERS_FILE, content: `* @${fork.owner}/${settings.reviewerTeam}\n` },
    ...input.workflowFiles.map((path) => ({ path, delete: true as const }))
  ]
  const message = [
    `chore: patchtogo scaffolding for ${packageName}@${release.version}`,
    '',
    `Renames the package to ${patchedName} ${version}, points repository at the fork, adds the unofficial-fork banner, the attribution notice and CODEOWNERS for the reviewer team, and removes the upstream workflows.`,
    '',
    `Patchtogo-Upstream: ${repoName(release.repository)}@${release.commit.sha}`
  ].join('\n')
  return { message, changes }
}
