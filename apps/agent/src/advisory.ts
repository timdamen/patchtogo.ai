import { z } from 'zod'

export const advisorySchema = z.object({
  ghsaId: z.string(),
  cveId: z.string().nullable(),
  packageName: z.string(),
  vulnerableRange: z.string(),
  patchedVersion: z.string().nullable(),
  severity: z.enum(['low', 'moderate', 'high', 'critical']),
  summary: z.string(),
  description: z.string()
})

export type Advisory = z.infer<typeof advisorySchema>
