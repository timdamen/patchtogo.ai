import type { FixerEnv } from '../env.ts'
import type { SandboxFixerOptions } from './sandbox-fixer.ts'

const MINUTE_MS = 60_000

export function fixerSettings(
  env: FixerEnv
): Pick<SandboxFixerOptions, 'credentials' | 'models' | 'limits'> {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = env
  const subagents = Object.fromEntries(
    Object.entries({
      investigator: env.PTG_MODEL_INVESTIGATOR,
      'exploit-test-writer': env.PTG_MODEL_EXPLOIT_TEST_WRITER,
      'patch-writer': env.PTG_MODEL_PATCH_WRITER,
      verifier: env.PTG_MODEL_VERIFIER,
      'diff-reviewer': env.PTG_MODEL_DIFF_REVIEWER
    }).filter(([, model]) => model !== undefined)
  )
  return {
    credentials: token && teamId && projectId ? { token, teamId, projectId } : undefined,
    models: {
      lead: env.PTG_MODEL,
      ...(env.PTG_MODEL_SMALL ? { small: env.PTG_MODEL_SMALL } : {}),
      subagents
    },
    limits: {
      maxTurns: env.PTG_FIXER_MAX_TURNS,
      maxBudgetUsd: env.PTG_FIXER_MAX_BUDGET_USD,
      testTimeoutMs: env.PTG_FIXER_TEST_TIMEOUT_MINUTES * MINUTE_MS,
      sandboxTimeoutMs: env.PTG_FIXER_TIMEOUT_MINUTES * MINUTE_MS
    }
  }
}
