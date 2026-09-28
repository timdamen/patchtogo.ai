import { z } from 'zod'

export const aiEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_WORKSPACE_ID: z.string().min(1).optional(),
  PTG_MODEL: z.string().min(1).default('claude-opus-5-5')
})

export const serverEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  PTG_RUN_TOKEN_SECRET: z.string().min(32)
})

const optionalModel = z.string().min(1).optional()

export const fixerEnvSchema = z
  .object({
    PTG_MODEL: z.string().min(1).default('claude-opus-5-5'),
    PTG_MODEL_PROXY_URL: z.url().optional(),
    PTG_MODEL_SMALL: optionalModel,
    PTG_MODEL_INVESTIGATOR: optionalModel,
    PTG_MODEL_EXPLOIT_TEST_WRITER: optionalModel,
    PTG_MODEL_PATCH_WRITER: optionalModel,
    PTG_MODEL_VERIFIER: optionalModel,
    PTG_MODEL_DIFF_REVIEWER: optionalModel,
    PTG_FIXER_MAX_TURNS: z.coerce.number().int().positive().default(80),
    PTG_FIXER_MAX_BUDGET_USD: z.coerce.number().positive().default(10),
    PTG_FIXER_TEST_TIMEOUT_MINUTES: z.coerce.number().positive().default(5),
    PTG_FIXER_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(40),
    VERCEL_TOKEN: z.string().min(1).optional(),
    VERCEL_TEAM_ID: z.string().min(1).optional(),
    VERCEL_PROJECT_ID: z.string().min(1).optional()
  })
  .refine(
    (env) =>
      [env.VERCEL_TOKEN, env.VERCEL_TEAM_ID, env.VERCEL_PROJECT_ID].every((v) => v === undefined) ||
      [env.VERCEL_TOKEN, env.VERCEL_TEAM_ID, env.VERCEL_PROJECT_ID].every((v) => v !== undefined),
    'set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID together, or none of them to use VERCEL_OIDC_TOKEN'
  )

export type AiEnv = z.infer<typeof aiEnvSchema>

export type FixerEnv = z.infer<typeof fixerEnvSchema>
