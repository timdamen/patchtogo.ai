import type { Notification, Notifier } from './pipeline/ports.ts'

const SUPPRESS_EMBEDS = 1 << 2
const MAX_REASON_LENGTH = 1500

function detail(notification: Notification): string {
  switch (notification.type) {
    case 'needs-human':
    case 'upstream-pr-blocked':
      return notification.reason
    case 'patch-pr-opened':
    case 'upstream-pr-opened':
      return notification.url
    case 'upstream-pr-ready':
      return notification.compareUrl
    case 'superseded':
      return notification.command
  }
}

export const consoleNotifier: Notifier = {
  async notify(notification) {
    console.log(
      `${notification.type}: ${notification.ghsaId} ${notification.packageName}: ${detail(notification)}`
    )
  }
}

function untrustedBlock(text: string): string {
  const clipped =
    text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH)}…` : text || '(none)'
  return ['```text', clipped.replaceAll('`', "'"), '```'].join('\n')
}

function inline(text: string): string {
  return `\`${text.replaceAll('`', "'")}\``
}

function discordMessage(notification: Notification): string {
  const { ghsaId, packageName, runId } = notification
  const advisory = `<https://github.com/advisories/${encodeURIComponent(ghsaId)}>`
  const run = `Run ${inline(runId)} · ${advisory}`
  switch (notification.type) {
    case 'patch-pr-opened':
      return [
        `**Patch PR ready for review:** ${inline(packageName)} for ${ghsaId}`,
        `<${encodeURI(notification.url)}>`,
        run
      ].join('\n')
    case 'upstream-pr-opened':
      return [
        `**Upstream PR opened:** ${inline(packageName)} for ${ghsaId}`,
        `<${encodeURI(notification.url)}>`,
        run
      ].join('\n')
    case 'upstream-pr-ready':
      return [
        `**Upstream PR ready to open:** ${inline(packageName)} for ${ghsaId}`,
        `<${encodeURI(notification.compareUrl)}>`,
        `The commit message fills in the title and description. Once it is open: ${inline(`pnpm --filter agent retry ${runId}`)}`,
        run
      ].join('\n')
    case 'superseded':
      return [
        `**Superseded upstream:** ${inline(`${packageName}@${notification.version}`)} fixes ${ghsaId}`,
        'Deprecate the patched release (npm trusted publishing cannot):',
        ['```sh', notification.command, '```'].join('\n'),
        run
      ].join('\n')
    case 'upstream-pr-blocked':
      return [
        `**Upstream PR needs a human:** ${inline(packageName)} for ${ghsaId}`,
        run,
        untrustedBlock(notification.reason)
      ].join('\n')
    case 'needs-human':
      return [
        `**Needs a human:** ${inline(packageName)} for ${ghsaId}`,
        run,
        untrustedBlock(notification.reason)
      ].join('\n')
  }
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
