export const automationLevels = ['triage-only', 'fork', 'full'] as const

export type Automation = (typeof automationLevels)[number]

export interface AutomationSettings {
  automation: Automation
  automationPackages: readonly string[]
}

export interface EffectiveAutomation {
  level: Automation
  because: string
}

export interface Hold {
  action: string
  needs: Automation
  reason: string
}

export function automationFor(
  packageName: string,
  { automation, automationPackages }: AutomationSettings
): EffectiveAutomation {
  if (automationPackages.length === 0) {
    return { level: automation, because: `PTG_AUTOMATION is ${automation}` }
  }
  if (automationPackages.includes(packageName)) {
    return {
      level: automation,
      because: `${packageName} is in PTG_AUTOMATION_PACKAGES and PTG_AUTOMATION is ${automation}`
    }
  }
  return {
    level: 'triage-only',
    because: `${packageName} is not in PTG_AUTOMATION_PACKAGES, so it stays at triage-only whatever PTG_AUTOMATION says`
  }
}

export function holdFor(
  packageName: string,
  action: string,
  needs: Automation,
  settings: AutomationSettings
): Hold | undefined {
  const { level, because } = automationFor(packageName, settings)
  if (automationLevels.indexOf(level) >= automationLevels.indexOf(needs)) return undefined
  return {
    action,
    needs,
    reason: `Held before ${action}, which needs automation level ${needs}: ${because}. Retry the run once that changes.`
  }
}
