import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import type { AiEnv } from './env.ts'

export function createModel(env: AiEnv): LanguageModel {
  return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(env.PTG_MODEL)
}
