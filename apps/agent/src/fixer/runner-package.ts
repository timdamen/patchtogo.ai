import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ShippedFile {
  path: string
  content: string
}

export async function runnerPackage(): Promise<ShippedFile[]> {
  const manifestPath = fileURLToPath(import.meta.resolve('@patchtogo/fixer-runner/package.json'))
  const root = path.dirname(manifestPath)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    name: string
    dependencies: Record<string, string>
  }
  const sources = (await readdir(path.join(root, 'src'))).filter((name) => name.endsWith('.ts'))
  return [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: manifest.name,
        private: true,
        type: 'module',
        dependencies: manifest.dependencies
      })
    },
    ...(await Promise.all(
      sources.map(async (name) => ({
        path: `src/${name}`,
        content: await readFile(path.join(root, 'src', name), 'utf8')
      }))
    ))
  ]
}
