import type { PublishedPackage, PublishedVersion, Registry } from '../../src/pipeline/ports.ts'

export class FakeRegistry implements Registry {
  readonly packages = new Map<string, PublishedPackage>()

  publish(name: string, version: string, details: Partial<PublishedVersion> = {}): void {
    const published = this.packages.get(name) ?? { name, versions: [] }
    published.versions.push({
      version,
      repository: null,
      gitHead: null,
      license: 'MIT',
      tarball: {
        url: `https://registry.npmjs.org/${name}/-/${name.replace(/^@[^/]+\//, '')}-${version}.tgz`,
        integrity: null
      },
      publishedAt: '2020-01-01T00:00:00.000Z',
      ...details
    })
    this.packages.set(name, published)
  }

  async getPackage(name: string): Promise<PublishedPackage | undefined> {
    const published = this.packages.get(name)
    return published && structuredClone(published)
  }
}
