import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import type { AiEnv } from './env.ts'

export function createModel(env: AiEnv): LanguageModel {
  return createAnthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    headers: env.ANTHROPIC_WORKSPACE_ID
      ? { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID }
      : undefined
  })(env.PTG_MODEL)
}
