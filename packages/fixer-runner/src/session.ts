import {
  query,
  type Options,
  type SDKMessage,
  type SDKResultMessage
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { leadPrompt, subagents, taskPrompt } from './agents.ts'
import {
  leadReportSchema,
  noUsage,
  type LeadReport,
  type RunnerInput,
  type Usage
} from './protocol.ts'
import { workdirGuard, writeTools } from './workdir-guard.ts'

export const TRANSCRIPT_PROJECT = 'run'

export const leadTools = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'Agent']

export const blockedTools = ['WebFetch', 'WebSearch']

export const bashDomains = ['registry.npmjs.org']

export function claudeEnv(
  input: RunnerInput,
  runToken: string,
  base: { PATH?: string; HOME?: string }
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: base.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: base.HOME ?? '/tmp',
    ANTHROPIC_BASE_URL: input.proxyBaseUrl,
    ANTHROPIC_AUTH_TOKEN: runToken,
    CLAUDE_CONFIG_DIR: input.configDir,
    CLAUDE_CODE_PROJECT_DIR_NAME: TRANSCRIPT_PROJECT,
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2',
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '5',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'patchtogo-fixer'
  }
  if (input.models.small) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = input.models.small
  return env
}

export function sessionOptions(
  input: RunnerInput,
  runToken: string,
  base: { PATH?: string; HOME?: string }
): Options {
  const sessionIdentity = input.session.resume
    ? { resume: input.session.id }
    : { sessionId: input.session.id }
  const env = claudeEnv(input, runToken, base)
  return {
    ...sessionIdentity,
    cwd: input.workdir,
    model: input.models.lead,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: leadPrompt },
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    tools: leadTools,
    allowedTools: leadTools,
    disallowedTools: blockedTools,
    agents: subagents(input.models),
    permissionMode: 'dontAsk',
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: bashDomains, strictAllowlist: true },
      filesystem: { allowWrite: [`${env.HOME}/.npm`] }
    },
    hooks: {
      PreToolUse: [{ matcher: writeTools.join('|'), hooks: [workdirGuard(input.workdir)] }]
    },
    maxTurns: input.limits.maxTurns,
    maxBudgetUsd: input.limits.maxBudgetUsd,
    outputFormat: { type: 'json_schema', schema: reportJsonSchema() },
    verbatimPrompts: true,
    persistSession: true,
    env
  }
}

export function reportJsonSchema(): Record<string, unknown> {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(leadReportSchema)
  return schema
}

export interface SessionOutcome {
  sessionId: string
  report: LeadReport | null
  error: string | null
  usage: Usage
}

export function usageOf(result: SDKResultMessage): Usage {
  const models = Object.values(result.modelUsage)
  const sum = (field: keyof Omit<Usage, 'costUsd' | 'turns'>) =>
    models.reduce((total, model) => total + (model[field] ?? 0), 0)
  return {
    costUsd: result.total_cost_usd,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadInputTokens: sum('cacheReadInputTokens'),
    cacheCreationInputTokens: sum('cacheCreationInputTokens'),
    turns: result.num_turns
  }
}

export function reportFrom(structuredOutput: unknown): { report: LeadReport } | { error: string } {
  const parsed = leadReportSchema.safeParse(structuredOutput)
  if (parsed.success) return { report: parsed.data }
  return { error: `the lead returned an invalid report: ${z.prettifyError(parsed.error)}` }
}

export function outcomeFrom(sessionId: string, messages: SDKMessage[]): SessionOutcome {
  const result = messages.findLast((message) => message.type === 'result')
  if (!result) {
    return {
      sessionId,
      report: null,
      error: 'the session ended without a result',
      usage: noUsage
    }
  }
  const usage = { sessionId, usage: usageOf(result) }
  if (result.subtype !== 'success' || result.is_error) {
    const reason = result.subtype === 'success' ? result.result : result.errors.join('; ')
    return { ...usage, report: null, error: `${result.subtype}: ${reason}` }
  }
  const parsed = reportFrom(result.structured_output)
  return 'report' in parsed
    ? { ...usage, report: parsed.report, error: null }
    : { ...usage, report: null, error: parsed.error }
}

export async function runSession(
  input: RunnerInput,
  runToken: string,
  emit: (message: SDKMessage) => void
): Promise<SessionOutcome> {
  const messages: SDKMessage[] = []
  const options = sessionOptions(input, runToken, process.env)
  let thrown: unknown
  try {
    for await (const message of query({ prompt: taskPrompt(input), options })) {
      emit(message)
      if (message.type === 'result') messages.push(message)
    }
  } catch (error) {
    thrown = error
  }
  const outcome = outcomeFrom(input.session.id, messages)
  if (outcome.error && thrown !== undefined && messages.length === 0) {
    return { ...outcome, error: thrown instanceof Error ? thrown.message : String(thrown) }
  }
  return outcome
}
