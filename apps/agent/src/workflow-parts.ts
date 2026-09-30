import { stringify } from 'yaml'
import { buildScript } from './builder/build-script.ts'
import type { RepoRef } from './pipeline/ports.ts'

const actions = {
  checkout: {
    uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    version: 'v7.0.1'
  },
  setupNode: {
    uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    version: 'v7.0.0'
  },
  uploadArtifact: {
    uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    version: 'v7.0.1'
  },
  downloadArtifact: {
    uses: 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
    version: 'v8.0.1'
  }
}

function action(name: keyof typeof actions, what: string, parameters: Record<string, unknown>) {
  const { uses, version } = actions[name]
  const [repository] = uses.split('@')
  return { name: `${what} (${repository} ${version})`, uses, with: parameters }
}

const setupNode = action('setupNode', 'Set up Node.js', {
  'node-version': 24,
  'package-manager-cache': false
})

interface RunStep {
  name: string
  run: string
}

export interface BuildSteps {
  checkout: string
  prepare: RunStep
  artifact: string
  keep?: Record<string, unknown>
}

export function buildSteps({ checkout, prepare, artifact, keep = {} }: BuildSteps) {
  return [
    action('checkout', checkout, { 'persist-credentials': false }),
    setupNode,
    prepare,
    {
      name: 'Build and pack like the tarball check',
      run: [
        `mkdir -p "$RUNNER_TEMP/${artifact}"`,
        `set -- "$PTG_PACKAGE_DIR" "$RUNNER_TEMP/${artifact}" "$PTG_BEFORE"`,
        buildScript
      ].join('\n')
    },
    action('uploadArtifact', 'Keep the tarball', {
      name: artifact,
      path: `\${{ runner.temp }}/${artifact}/*.tgz`,
      'if-no-files-found': 'error',
      ...keep
    })
  ]
}

export function publishSteps(artifact: string, publish: RunStep) {
  return [
    setupNode,
    action('downloadArtifact', 'Fetch the tarball', { name: artifact, path: artifact }),
    publish
  ]
}

const safeName = /^[A-Za-z0-9._-]+$/
const safePath = /^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/
const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

export function checked(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value) || value.split('/').includes('..')) {
    throw new Error(`a patchtogo workflow cannot use the ${what} ${JSON.stringify(value)}`)
  }
  return value
}

export function safeRepository(fork: RepoRef): string {
  return [checked(fork.owner, safeName, 'owner'), checked(fork.repo, safeName, 'repository')].join(
    '/'
  )
}

export function safeDirectory(directory: string): string {
  return directory ? checked(directory, safePath, 'directory') : '.'
}

export function safeFile(path: string, what: string): string {
  return checked(path, safePath, what)
}

export function safeBefore(publishedAt: string | null): string {
  return publishedAt ? checked(publishedAt, isoDate, 'publish time') : ''
}

export function workflowYaml(workflow: object): string {
  return stringify(workflow, { version: '1.1', lineWidth: 0, aliasDuplicateObjects: false })
}
