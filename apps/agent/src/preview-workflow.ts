import { stringify } from 'yaml'
import { buildEnv, buildScript } from './builder/build-script.ts'
import { PATCH_BRANCH_PREFIX } from './naming.ts'
import type { RepoRef } from './pipeline/ports.ts'
import { repoName } from './upstream.ts'

export const PREVIEW_WORKFLOW_FILE = '.github/workflows/patchtogo-preview.yml'

const PKG_PR_NEW = 'pkg-pr-new@0.0.88'

const actions = {
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  setupNode: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  uploadArtifact: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  downloadArtifact: 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'
}

const versions = {
  checkout: 'v7.0.1',
  setupNode: 'v7.0.0',
  uploadArtifact: 'v7.0.1',
  downloadArtifact: 'v8.0.1'
}

export interface PreviewWorkflowInput {
  fork: RepoRef
  directory: string
  readmePath: string
  publishedAt: string | null
}

const safeName = /^[A-Za-z0-9._-]+$/
const safePath = /^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/
const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

function checked(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value) || value.split('/').includes('..')) {
    throw new Error(`the preview workflow cannot use the ${what} ${JSON.stringify(value)}`)
  }
  return value
}

const markPreview = String.raw`node - <<'PTG_PREVIEW'
const fs = require("node:fs")
const path = require("node:path")
const env = process.env
const manifestPath = path.join(env.PTG_PACKAGE_DIR, "package.json")
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
const short = env.GITHUB_SHA.slice(0, 7)
manifest.version += (manifest.version.includes("-") ? "." : "-") + "preview-" + short
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
const commit = env.GITHUB_SERVER_URL + "/" + env.GITHUB_REPOSITORY + "/commit/" + env.GITHUB_SHA
const label = manifest.name + "@" + manifest.version
const warning = "The patch was written by an AI agent and has not been reviewed yet: use this build only as an emergency stopgap until a reviewed release is published."
const banner = /\.(md|markdown)$/i.test(env.PTG_README)
  ? "> [!CAUTION]\n> **Unreviewed preview.** \x60" + label + "\x60 was built from commit [" + short + "](" + commit + ") of an open patchtogo pull request. " + warning
  : "UNREVIEWED PREVIEW: " + label + " was built from " + commit + ", a commit of an open patchtogo pull request. " + warning
const readme = fs.existsSync(env.PTG_README) ? fs.readFileSync(env.PTG_README, "utf8") : ""
fs.writeFileSync(env.PTG_README, banner + "\n\n" + readme)
PTG_PREVIEW`

export function previewWorkflow(input: PreviewWorkflowInput): string {
  const repository = [
    checked(input.fork.owner, safeName, 'owner'),
    checked(input.fork.repo, safeName, 'repository')
  ].join('/')
  const directory = input.directory ? checked(input.directory, safePath, 'directory') : '.'
  const readme = checked(input.readmePath, safePath, 'README path')
  const before = input.publishedAt ? checked(input.publishedAt, isoDate, 'publish time') : ''
  const onlyHere = `github.repository == '${repository}'`
  const setupNode = {
    name: `Set up Node.js (actions/setup-node ${versions.setupNode})`,
    uses: actions.setupNode,
    with: { 'node-version': 24, 'package-manager-cache': false }
  }
  const workflow = {
    name: 'patchtogo preview (unreviewed)',
    on: { push: { branches: [`${PATCH_BRANCH_PREFIX}**`] } },
    permissions: {},
    concurrency: {
      group: 'patchtogo-preview-${{ github.ref }}',
      'cancel-in-progress': true
    },
    defaults: { run: { shell: 'bash' } },
    jobs: {
      build: {
        if: onlyHere,
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': 20,
        permissions: { contents: 'read' },
        env: {
          ...buildEnv,
          PTG_PACKAGE_DIR: directory,
          PTG_README: readme,
          PTG_BEFORE: before
        },
        steps: [
          {
            name: `Check out the patch commit (actions/checkout ${versions.checkout})`,
            uses: actions.checkout,
            with: { 'persist-credentials': false }
          },
          setupNode,
          { name: 'Mark the package as an unreviewed preview', run: markPreview },
          {
            name: 'Build and pack like the tarball check',
            run: [
              'mkdir -p "$RUNNER_TEMP/preview"',
              'set -- "$PTG_PACKAGE_DIR" "$RUNNER_TEMP/preview" "$PTG_BEFORE"',
              buildScript
            ].join('\n')
          },
          {
            name: `Keep the tarball (actions/upload-artifact ${versions.uploadArtifact})`,
            uses: actions.uploadArtifact,
            with: {
              name: 'preview',
              path: '${{ runner.temp }}/preview/*.tgz',
              'if-no-files-found': 'error',
              'retention-days': 7
            }
          }
        ]
      },
      publish: {
        needs: 'build',
        if: onlyHere,
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': 10,
        permissions: {},
        steps: [
          setupNode,
          {
            name: `Fetch the tarball (actions/download-artifact ${versions.downloadArtifact})`,
            uses: actions.downloadArtifact,
            with: { name: 'preview', path: 'preview' }
          },
          {
            name: 'Publish the preview to pkg.pr.new',
            run: `npx --yes ${PKG_PR_NEW} publish --no-compact --no-template --comment=update --commentWithSha ./preview/*.tgz`
          }
        ]
      }
    }
  }
  return stringify(workflow, { version: '1.1', lineWidth: 0, aliasDuplicateObjects: false })
}

export function previewInstallUrl(fork: RepoRef, packageName: string, commit: string): string {
  return `https://pkg.pr.new/${repoName(fork)}/${packageName}@${commit.slice(0, 7)}`
}
