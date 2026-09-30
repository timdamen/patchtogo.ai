import type { Advisory } from '../../src/advisory.ts'
import type { Classification } from '../../src/comment-classification.ts'
import { InMemoryStore } from '../../src/pipeline/memory-store.ts'
import type { Automation } from '../../src/pipeline/automation.ts'
import type { PipelineEvent } from '../../src/pipeline/events.ts'
import {
  createPipeline,
  type Pipeline,
  type PipelineSettings
} from '../../src/pipeline/pipeline.ts'
import type { FixResult, Store } from '../../src/pipeline/ports.ts'
import { withTestAdvisories } from '../../src/test-advisories.ts'
import type { Triage } from '../../src/triage.ts'
import { ScriptedBuilder } from './builder.ts'
import { FakeClock } from './clock.ts'
import { RecordingModelAccess, ScriptedFixer } from './fixer.ts'
import { InMemoryGitHub } from './github.ts'
import { classificationModel, triageModel } from './model.ts'
import { RecordingNotifier } from './notifier.ts'
import { FakeRegistry } from './registry.ts'

interface TestPipelineOptions {
  triage?: (advisory: Advisory) => Triage
  fixes?: (FixResult | Error)[]
  store?: Store
  automation?: Automation
  automationPackages?: string[]
  requiredApprovals?: number
  upstreamAccount?: boolean
  classify?: (comments: string[]) => Classification
}

const testSettings: PipelineSettings = {
  forkOrg: 'patchtogo-ai',
  npmScope: 'patchtogo.ai',
  reviewerTeam: 'reviewers',
  requiredApprovals: 2,
  automation: 'fork',
  automationPackages: []
}

function unexpectedTriage(advisory: Advisory): Triage {
  throw new Error(`unexpected triage of ${advisory.packageName}`)
}

export function createTestPipeline({
  triage = unexpectedTriage,
  fixes,
  store = new InMemoryStore(),
  automation = testSettings.automation,
  automationPackages = [],
  requiredApprovals = testSettings.requiredApprovals,
  upstreamAccount = false,
  classify = () => ({ actionable: true, reply: '' })
}: TestPipelineOptions = {}) {
  const github = new InMemoryGitHub()
  const ports = {
    github,
    registry: new FakeRegistry(),
    builder: new ScriptedBuilder(),
    fixer: new ScriptedFixer(fixes),
    modelAccess: new RecordingModelAccess(),
    model: triageModel(triage),
    smallModel: classificationModel(classify),
    store,
    notifier: new RecordingNotifier(),
    clock: new FakeClock(),
    upstreamAccount: upstreamAccount ? github.upstreamAccount() : undefined
  }
  const settings = { ...testSettings, automation, automationPackages, requiredApprovals }
  const pipelinePorts = { ...ports, github: withTestAdvisories(github, store) }
  return {
    ...ports,
    pipeline: createPipeline(pipelinePorts, settings),
    withAutomation: (level: Automation, packages = automationPackages) =>
      createPipeline(pipelinePorts, {
        ...settings,
        automation: level,
        automationPackages: packages
      })
  }
}

export function inlineQueue(pipeline: Pipeline) {
  return {
    send: (event: PipelineEvent) => pipeline.handle(event),
    retryFailedJobs: async () => 0,
    failedKeys: async (): Promise<string[]> => []
  }
}
