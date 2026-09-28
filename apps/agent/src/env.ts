import { z } from 'zod'

export const aiEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_WORKSPACE_ID: z.string().min(1).optional(),
  PTG_MODEL: z.string().min(1).default('claude-opus-5-5')
})

export const serverEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  PTG_RUN_TOKEN_SECRET: z.string().min(32),
  GITHUB_TOKEN: z
    .string()
    .optional()
    .transform((token) => token || undefined),
  PTG_POLL_INTERVAL_MINUTES: z.coerce.number().positive().default(15),
  PTG_POLL_LOOKBACK_HOURS: z.coerce.number().nonnegative().default(24)
})

export type AiEnv = z.infer<typeof aiEnvSchema>
