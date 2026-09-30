import { posix } from 'node:path'
import { buildEnv, buildScript } from './builder/build-script.ts'
import { BASE_BRANCH_PREFIX, PATCH_BRANCH_PREFIX } from './naming.ts'
import type { RepoRef } from './pipeline/ports.ts'
import {
  actions,
  actionVersions,
  safeBefore,
  safeDirectory,
  safeRepository,
  setupNode,
  workflowYaml
} from './workflow-parts.ts'

export const STABLE_WORKFLOW_FILE = '.github/workflows/patchtogo-release.yml'

export const STABLE_WORKFLOW_NAME = posix.basename(STABLE_WORKFLOW_FILE)

const packageName = /^@[a-z0-9._-]+\/[a-z0-9._-]+$/
const version = /^[0-9A-Za-z.+-]+$/

export interface StableWorkflowInput {
  fork: RepoRef
  packageName: string
  upstreamVersion: string
  directory: string
  publishedAt: string | null
}

const patchMerge = String.raw`node --input-type=module - <<'PTG_GATE'
import { appendFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
const env = process.env
const url = env.GITHUB_API_URL + "/repos/" + env.GITHUB_REPOSITORY + "/commits/" + env.GITHUB_SHA + "/pulls"
const isPatchMerge = (pull) =>
  pull.merged_at !== null &&
  pull.merge_commit_sha === env.GITHUB_SHA &&
  pull.head.ref.startsWith(env.PTG_PATCH_PREFIX) &&
  pull.head.repo !== null &&
  pull.head.repo.full_name === env.GITHUB_REPOSITORY
let pulls = []
for (let attempt = 1; attempt <= 6; attempt++) {
  const response = await fetch(url, { headers: { accept: "application/vnd.github+json", authorization: "Bearer " + env.GH_TOKEN } })
  if (!response.ok) throw new Error(url + " answered " + response.status)
  pulls = await response.json()
  if (pulls.length > 0 || attempt === 6) break
  await sleep(10000)
}
const release = pulls.some(isPatchMerge)
console.log(release ? env.GITHUB_SHA + " merges a patch pull request" : env.GITHUB_SHA + " merges no patch pull request, so nothing is released")
appendFileSync(env.GITHUB_OUTPUT, "release=" + release + "\n")
PTG_GATE`

const chooseVersion = String.raw`node - <<'PTG_VERSION'
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const env = process.env
const manifestPath = path.join(env.PTG_PACKAGE_DIR, "package.json")
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
if (manifest.name !== env.PTG_PACKAGE_NAME) {
  throw new Error(manifestPath + " names " + manifest.name + ", not " + env.PTG_PACKAGE_NAME)
}
let answer
try {
  answer = execFileSync("npm", ["view", env.PTG_PACKAGE_NAME, "versions", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
} catch (error) {
  answer = error.stdout
}
if (!answer || !answer.trim()) throw new Error("npm view printed nothing for " + env.PTG_PACKAGE_NAME)
const published = JSON.parse(answer)
if (published.error && published.error.code !== "E404") throw new Error("npm view failed: " + published.error.summary)
const versions = published.error ? [] : [].concat(published)
const prefix = env.PTG_UPSTREAM_VERSION + "-ptg."
const releases = versions.filter((v) => v.startsWith(prefix)).map((v) => Number(v.slice(prefix.length))).filter(Number.isSafeInteger)
manifest.version = prefix + (Math.max(0, ...releases) + 1)
manifest.gitHead = env.GITHUB_SHA
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
console.log("Releasing " + manifest.name + "@" + manifest.version + " from " + env.GITHUB_SHA)
PTG_VERSION`

function checkedName(name: string): string {
  if (!packageName.test(name)) throw new Error(`the stable release workflow cannot publish ${name}`)
  return name
}

function checkedVersion(upstreamVersion: string): string {
  if (!version.test(upstreamVersion)) {
    throw new Error(`the stable release workflow cannot release version ${upstreamVersion}`)
  }
  return upstreamVersion
}

export function stableReleaseWorkflow(input: StableWorkflowInput): string {
  const repository = safeRepository(input.fork)
  const onlyHere = [
    `github.repository == '${repository}'`,
    `github.event_name == 'push'`,
    `startsWith(github.ref, 'refs/heads/${BASE_BRANCH_PREFIX}')`
  ].join(' && ')
  const released = `${onlyHere} && needs.gate.outputs.release == 'true'`
  const workflow = {
    name: 'patchtogo stable release',
    on: { push: { branches: [`${BASE_BRANCH_PREFIX}**`] } },
    permissions: {},
    concurrency: {
      group: 'patchtogo-stable-release-${{ github.ref }}',
      'cancel-in-progress': false
    },
    defaults: { run: { shell: 'bash' } },
    jobs: {
      gate: {
        if: onlyHere,
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': 5,
        permissions: { contents: 'read', 'pull-requests': 'read' },
        outputs: { release: '${{ steps.merge.outputs.release }}' },
        steps: [
          {
            id: 'merge',
            name: 'Release only the merge of a patch pull request',
            env: { GH_TOKEN: '${{ github.token }}', PTG_PATCH_PREFIX: PATCH_BRANCH_PREFIX },
            run: patchMerge
          }
        ]
      },
      build: {
        needs: 'gate',
        if: released,
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': 20,
        permissions: { contents: 'read' },
        env: {
          ...buildEnv,
          PTG_PACKAGE_NAME: checkedName(input.packageName),
          PTG_UPSTREAM_VERSION: checkedVersion(input.upstreamVersion),
          PTG_PACKAGE_DIR: safeDirectory(input.directory),
          PTG_BEFORE: safeBefore(input.publishedAt)
        },
        steps: [
          {
            name: `Check out the merge commit (actions/checkout ${actionVersions.checkout})`,
            uses: actions.checkout,
            with: { 'persist-credentials': false }
          },
          setupNode,
          { name: 'Choose the next -ptg.N version', run: chooseVersion },
          {
            name: 'Build and pack like the tarball check',
            run: [
              'mkdir -p "$RUNNER_TEMP/release"',
              'set -- "$PTG_PACKAGE_DIR" "$RUNNER_TEMP/release" "$PTG_BEFORE"',
              buildScript
            ].join('\n')
          },
          {
            name: `Keep the tarball (actions/upload-artifact ${actionVersions.uploadArtifact})`,
            uses: actions.uploadArtifact,
            with: {
              name: 'release',
              path: '${{ runner.temp }}/release/*.tgz',
              'if-no-files-found': 'error'
            }
          }
        ]
      },
      publish: {
        needs: ['gate', 'build'],
        if: released,
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': 10,
        permissions: { 'id-token': 'write' },
        steps: [
          setupNode,
          {
            name: `Fetch the tarball (actions/download-artifact ${actionVersions.downloadArtifact})`,
            uses: actions.downloadArtifact,
            with: { name: 'release', path: 'release' }
          },
          {
            name: 'Publish to npm with provenance through trusted publishing',
            run: 'npm publish ./release/*.tgz --provenance --access public --tag latest --ignore-scripts'
          }
        ]
      }
    }
  }
  return workflowYaml(workflow)
}
