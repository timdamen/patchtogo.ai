export const automationLevels = ['triage-only', 'fork', 'full'] as const

export type Automation = (typeof automationLevels)[number]
