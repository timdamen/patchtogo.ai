import type { Advisory } from '../../src/advisory.ts'
import { InMemoryStore } from '../../src/pipeline/memory-store.ts'
import { createPipeline, type PipelineSettings } from '../../src/pipeline/pipeline.ts'
import type { FixResult, Store } from '../../src/pipeline/ports.ts'
import type { Triage } from '../../src/triage.ts'
import { ScriptedBuilder } from './builder.ts'
import { FakeClock } from './clock.ts'
import { ScriptedFixer } from './fixer.ts'
import { InMemoryGitHub } from './github.ts'
import { triageModel } from './model.ts'
import { RecordingNotifier } from './notifier.ts'
import { FakeRegistry } from './registry.ts'

interface TestPipelineOptions {
  triage?: (advisory: Advisory) => Triage
  fixes?: FixResult[]
  store?: Store
}

export const testSettings: PipelineSettings = {
  forkOrg: 'patchtogo-ai',
  npmScope: 'patchtogo.ai',
  reviewerTeam: 'reviewers'
}

function unexpectedTriage(advisory: Advisory): Triage {
  throw new Error(`unexpected triage of ${advisory.packageName}`)
}

export function createTestPipeline({
  triage = unexpectedTriage,
  fixes,
  store = new InMemoryStore()
}: TestPipelineOptions = {}) {
  const ports = {
    github: new InMemoryGitHub(),
    registry: new FakeRegistry(),
    builder: new ScriptedBuilder(),
    fixer: new ScriptedFixer(fixes),
    model: triageModel(triage),
    store,
    notifier: new RecordingNotifier(),
    clock: new FakeClock()
  }
  return { ...ports, pipeline: createPipeline(ports, testSettings) }
}
