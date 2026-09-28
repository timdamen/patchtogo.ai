import type { PublishedVersion, RepoRef } from '../../src/pipeline/ports.ts'
import type { InMemoryGitHub } from './github.ts'
import type { FakeRegistry } from './registry.ts'

export interface UpstreamPackage {
  name: string
  version: string
  repository?: RepoRef
  files?: Record<string, string>
  tags?: string[]
  published?: Partial<PublishedVersion>
}

export function packageJson(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields, null, 2)}\n`
}

export function upstreamFiles(name: string, version: string): Record<string, string> {
  return {
    'package.json': packageJson({ name, version, main: 'index.js', files: ['index.js'] }),
    'README.md': `# ${name}\n\nEscapes HTML.\n`,
    LICENSE: 'MIT License\n\nCopyright (c) upstream authors\n',
    'index.js': 'module.exports = (s) => s\n',
    '.github/workflows/ci.yml': 'on: push\n',
    '.github/workflows/publish.yml': 'on: release\n'
  }
}

export function seedUpstream(
  github: InMemoryGitHub,
  registry: FakeRegistry,
  pkg: UpstreamPackage
): { repository: RepoRef; sha: string } {
  const repository = pkg.repository ?? {
    owner: 'upstream',
    repo: pkg.name.replace(/^@[^/]+\//, '')
  }
  const sha = github.addRepository(repository, {
    files: pkg.files ?? upstreamFiles(pkg.name, pkg.version),
    tags: pkg.tags ?? [`v${pkg.version}`],
    branches: ['develop']
  })
  registry.publish(pkg.name, pkg.version, {
    repository: {
      url: `git+https://github.com/${repository.owner}/${repository.repo}.git`,
      directory: null
    },
    ...pkg.published
  })
  return { repository, sha }
}
