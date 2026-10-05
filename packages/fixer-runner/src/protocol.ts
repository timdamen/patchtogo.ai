import { z } from 'zod'

export const subagentNames = [
  'investigator',
  'exploit-test-writer',
  'patch-writer',
  'verifier',
  'diff-reviewer'
] as const

export type SubagentName = (typeof subagentNames)[number]

export const runnerInputSchema = z.object({
  workdir: z.string().startsWith('/'),
  configDir: z.string().startsWith('/'),
  resultPath: z.string().startsWith('/'),
  scratchDir: z.string().startsWith('/'),
  tokenPath: z.string().startsWith('/'),
  session: z.object({ id: z.uuid(), resume: z.boolean() }),
  priorDiff: z.string().nullable(),
  proxyBaseUrl: z.url(),
  models: z.object({
    lead: z.string().min(1),
    small: z.string().min(1).optional(),
    subagents: z.partialRecord(z.enum(subagentNames), z.string().min(1))
  }),
  limits: z.object({
    maxTurns: z.number().int().positive(),
    maxBudgetUsd: z.number().positive(),
    testTimeoutMs: z.number().int().positive()
  }),
  task: z.object({
    advisory: z.looseObject({ ghsaId: z.string(), packageName: z.string() }),
    triage: z.object({
      reason: z.string(),
      suspectedFiles: z.array(z.string()),
      fixStrategy: z.string()
    }),
    instructions: z.array(z.string()),
    untrustedContext: z.array(z.string())
  })
})

export type RunnerInput = z.infer<typeof runnerInputSchema>

export const leadReportSchema = z.object({
  summary: z
    .string()
    .describe('What changed and why, in a few sentences a reviewer can read in the PR.'),
  regressionTest: z.object({
    files: z
      .array(z.string())
      .min(1)
      .describe('Paths of the regression test files, relative to the package root.'),
    command: z
      .string()
      .min(1)
      .describe(
        'Shell command, run from the package root, that exits non-zero while the package is vulnerable and zero once it is fixed.'
      )
  }),
  concerns: z
    .array(z.string())
    .describe('Open findings from the diff review that the reviewers should look at.')
})

export type LeadReport = z.infer<typeof leadReportSchema>

export const testRunSchema = z.object({
  command: z.string(),
  exitCode: z.number().int().nullable(),
  passed: z.boolean(),
  output: z.string()
})

export type TestRun = z.infer<typeof testRunSchema>

export const upstreamSuiteSchema = z.discriminatedUnion('suite', [
  z.object({ suite: z.literal('none'), reason: z.string() }),
  z.object({
    suite: z.literal('ran'),
    command: z.string(),
    before: testRunSchema,
    after: testRunSchema
  })
])

export type UpstreamSuite = z.infer<typeof upstreamSuiteSchema>

export const regressionVerdicts = ['red-to-green', 'not-red-before', 'not-green-after'] as const

export const usageSchema = z.object({
  costUsd: z.number(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadInputTokens: z.number().int(),
  cacheCreationInputTokens: z.number().int(),
  turns: z.number().int()
})

export type Usage = z.infer<typeof usageSchema>

export const noUsage: Usage = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  turns: 0
}

export const runnerResultSchema = z.object({
  sessionId: z.string(),
  report: leadReportSchema.nullable(),
  error: z.string().nullable(),
  diff: z.string(),
  regression: z
    .object({
      before: testRunSchema,
      after: testRunSchema,
      verdict: z.enum(regressionVerdicts)
    })
    .nullable(),
  upstreamTests: upstreamSuiteSchema.nullable(),
  usage: usageSchema
})

export type RunnerResult = z.infer<typeof runnerResultSchema>

export const runnerEventSchema = z.object({
  type: z.literal('ptg_runner'),
  event: z.string(),
  detail: z.string().optional()
})

export type RunnerEvent = z.infer<typeof runnerEventSchema>

const promptTags = [
  'advisory',
  'triage',
  'reviewer-instruction',
  'untrusted-comment',
  'reviewer-comment'
] as const

type PromptTag = (typeof promptTags)[number]

const promptTag = new RegExp(`<\\s*(\\/?)\\s*(${promptTags.join('|')})\\b`, 'gi')

export function tagged(tag: PromptTag, body: string): string {
  return `<${tag}>\n${body.replaceAll(promptTag, '‹$1$2')}\n</${tag}>`
}

const sandboxPlaceholders = new Set([
  '.bash_profile',
  '.bashrc',
  '.claude/agents',
  '.claude/commands',
  '.gitconfig',
  '.gitmodules',
  '.idea',
  '.mcp.json',
  '.npmrc',
  '.profile',
  '.ripgreprc',
  '.vscode',
  '.zprofile',
  '.zshrc',
  'bunfig.toml',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock'
])

export function isSandboxPlaceholder(file: string): boolean {
  return sandboxPlaceholders.has(file) || /^\.(env|yarnrc)[^/]*$/.test(file)
}
