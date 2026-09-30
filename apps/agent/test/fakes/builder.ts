import type { Builder, BuildRequest, BuildResult, PackageFiles } from '../../src/pipeline/ports.ts'

export const matchingPackage: PackageFiles = {
  files: { 'package.json': 'aaa', 'index.js': 'bbb', 'README.md': 'ccc' },
  packageJson: { name: 'escape-html', version: '1.0.3', main: 'index.js' }
}

export class ScriptedBuilder implements Builder {
  readonly requests: BuildRequest[] = []
  outcome: (request: BuildRequest) => Omit<BuildResult, 'sandboxSeconds'> = () => ({
    published: matchingPackage,
    built: structuredClone(matchingPackage),
    log: 'npm pack'
  })

  async build(request: BuildRequest): Promise<BuildResult> {
    this.requests.push(structuredClone(request))
    return { ...structuredClone(this.outcome(request)), sandboxSeconds: 42 }
  }
}
