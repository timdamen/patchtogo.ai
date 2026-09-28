import type { Notification, Notifier } from './pipeline/ports.ts'

const SUPPRESS_EMBEDS = 1 << 2
const MAX_REASON_LENGTH = 1500

export const consoleNotifier: Notifier = {
  async notify(notification) {
    console.log(
      `${notification.type}: ${notification.ghsaId} ${notification.packageName}: ${notification.reason}`
    )
  }
}

function untrustedBlock(text: string): string {
  const clipped =
    text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH)}…` : text || '(none)'
  return ['```text', clipped.replaceAll('`', "'"), '```'].join('\n')
}

function discordMessage(notification: Notification): string {
  const { ghsaId, packageName, runId, reason } = notification
  return [
    `**Needs a human:** \`${packageName.replaceAll('`', "'")}\` for ${ghsaId}`,
    `Run \`${runId.replaceAll('`', "'")}\` · <https://github.com/advisories/${encodeURIComponent(ghsaId)}>`,
    untrustedBlock(reason)
  ].join('\n')
}

export function createDiscordNotifier(options: {
  webhookUrl: string
  fetch?: typeof globalThis.fetch
}): Notifier {
  const { webhookUrl, fetch = globalThis.fetch } = options
  return {
    async notify(notification) {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: discordMessage(notification),
          allowed_mentions: { parse: [] },
          flags: SUPPRESS_EMBEDS
        })
      })
      if (!response.ok) {
        throw new Error(`the Discord webhook answered ${response.status} ${response.statusText}`)
      }
    }
  }
}
