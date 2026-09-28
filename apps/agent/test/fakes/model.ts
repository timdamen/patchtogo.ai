import { MockLanguageModelV4 } from 'ai/test'
import { advisorySchema, type Advisory } from '../../src/advisory.ts'
import type { Triage } from '../../src/triage.ts'

type Prompt = Parameters<MockLanguageModelV4['doGenerate']>[0]['prompt']

function advisoryInPrompt(prompt: Prompt): Advisory {
  for (const message of prompt) {
    if (message.role !== 'user') continue
    for (const part of message.content) {
      if (part.type !== 'text') continue
      const match = /<advisory>\n([\s\S]*)\n<\/advisory>/.exec(part.text)
      if (match?.[1]) return advisorySchema.parse(JSON.parse(match[1]))
    }
  }
  throw new Error('the prompt carries no <advisory> block')
}

export function triageModel(answer: (advisory: Advisory) => Triage): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => ({
      content: [{ type: 'text', text: JSON.stringify(answer(advisoryInPrompt(prompt))) }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined }
      },
      warnings: []
    })
  })
}
