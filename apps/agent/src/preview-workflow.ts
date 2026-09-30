import { buildEnv } from './builder/build-script.ts'
import { PATCH_BRANCH_PREFIX } from './naming.ts'
import type { RepoRef } from './pipeline/ports.ts'
import { repoName } from './upstream.ts'
import {
  buildSteps,
  publishSteps,
  safeBefore,
  safeDirectory,
  safeFile,
  safeRepository,
  workflowYaml
} from './workflow-parts.ts'

export const PREVIEW_WORKFLOW_FILE = '.github/workflows/patchtogo-preview.yml'

const PKG_PR_NEW = 'pkg-pr-new@0.0.88'

export interface PreviewWorkflowInput {
  fork: RepoRef
  directory: string
  readmePath: string
  publishedAt: string | null
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
  const repository = safeRepository(input.fork)
  const directory = safeDirectory(input.directory)
  const readme = safeFile(input.readmePath, 'README path')
  const before = safeBefore(input.publishedAt)
  const onlyHere = `github.repository == '${repository}'`
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
        steps: buildSteps({
          checkout: 'Check out the patch commit',
          prepare: { name: 'Mark the package as an unreviewed preview', run: markPreview },
          artifact: 'preview',
          keep: { 'retention-days': 7 }
        })
      },
      publish: {
        needs: 'build',
        if: onlyHere,
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': 10,
        permissions: {},
        steps: publishSteps('preview', {
          name: 'Publish the preview to pkg.pr.new',
          run: `npx --yes ${PKG_PR_NEW} publish --no-compact --no-template --comment=update --commentWithSha ./preview/*.tgz`
        })
      }
    }
  }
  return workflowYaml(workflow)
}

export function previewInstallUrl(fork: RepoRef, packageName: string, commit: string): string {
  return `https://pkg.pr.new/${repoName(fork)}/${packageName}@${commit.slice(0, 7)}`
}
