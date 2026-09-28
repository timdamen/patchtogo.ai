import type { Advisory } from '../../src/advisory.ts'
import { InMemoryStore } from '../../src/pipeline/memory-store.ts'
import { createPipeline } from '../../src/pipeline/pipeline.ts'
import type { FixResult } from '../../src/pipeline/ports.ts'
import type { Triage } from '../../src/triage.ts'
import { FakeClock } from './clock.ts'
import { ScriptedFixer } from './fixer.ts'
import { InMemoryGitHub } from './github.ts'
import { triageModel } from './model.ts'
import { RecordingNotifier } from './notifier.ts'

interface TestPipelineOptions {
  triage?: (advisory: Advisory) => Triage
  fixes?: FixResult[]
}

function unexpectedTriage(advisory: Advisory): Triage {
  throw new Error(`unexpected triage of ${advisory.packageName}`)
}

export function createTestPipeline({ triage = unexpectedTriage, fixes }: TestPipelineOptions = {}) {
  const ports = {
    github: new InMemoryGitHub(),
    fixer: new ScriptedFixer(fixes),
    model: triageModel(triage),
    store: new InMemoryStore(),
    notifier: new RecordingNotifier(),
    clock: new FakeClock()
  }
  return { ...ports, pipeline: createPipeline(ports) }
}
