import type { PipelineEvent } from './pipeline/events.ts'
import type { Registry, Store } from './pipeline/ports.ts'
import { watchedPackages } from './pipeline/superseding.ts'

export interface UpstreamWatchOptions {
  store: Store
  registry: Registry
  emit(event: PipelineEvent): Promise<void>
}

export interface UpstreamWatch {
  check(): Promise<number>
}

export function createUpstreamWatch({
  store,
  registry,
  emit
}: UpstreamWatchOptions): UpstreamWatch {
  return {
    async check() {
      let emitted = 0
      for (const packageName of await watchedPackages(store)) {
        const version = (await registry.getPackage(packageName))?.latest
        if (!version) continue
        await emit({ type: 'upstream-version-published', packageName, version })
        emitted++
      }
      return emitted
    }
  }
}
