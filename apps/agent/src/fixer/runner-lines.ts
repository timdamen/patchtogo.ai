export type RunnerLine = { type: string } & Record<string, unknown>

export function lineSplitter(onLine: (line: string) => void) {
  let pending = ''
  return {
    push(chunk: string) {
      const parts = (pending + chunk).split('\n')
      pending = parts.pop() ?? ''
      for (const part of parts) if (part.trim()) onLine(part)
    },
    end() {
      if (pending.trim()) onLine(pending)
      pending = ''
    }
  }
}

export function parseRunnerLine(line: string): RunnerLine | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string') return undefined
  return record as RunnerLine
}

interface ContentBlock {
  type?: string
  name?: string
  input?: { subagent_type?: string; description?: string }
}

function agentCalls(line: RunnerLine): string[] {
  const message = line.message as { content?: ContentBlock[] } | undefined
  if (!Array.isArray(message?.content)) return []
  return message.content
    .filter((block) => block.type === 'tool_use' && block.name === 'Agent')
    .map(
      (block) => `${block.input?.subagent_type ?? 'subagent'}: ${block.input?.description ?? ''}`
    )
}

function names(value: unknown) {
  if (!Array.isArray(value)) return '[]'
  return `[${value.map((item) => (typeof item === 'string' ? item : (item as { name?: string }).name)).join(', ')}]`
}

function money(value: unknown) {
  return typeof value === 'number' ? `$${value.toFixed(2)}` : 'unknown cost'
}

export function describeLine(line: RunnerLine): string | undefined {
  switch (line.type) {
    case 'ptg_runner':
      return `runner: ${line.event}${line.detail ? ` (${line.detail})` : ''}`
    case 'system':
      if (line.subtype === 'init') {
        return `session ${line.session_id} on ${line.model}, tools ${names(line.tools)}, MCP servers ${names(line.mcp_servers)}`
      }
      if (line.subtype === 'task_notification') {
        return `subagent ${line.status}: ${line.summary ?? line.task_id}`
      }
      return undefined
    case 'assistant': {
      const calls = agentCalls(line)
      if (calls.length === 0) return undefined
      return calls.map((call) => `delegating to ${call}`).join('\n')
    }
    case 'result':
      return `session ${line.subtype} after ${line.num_turns} turns, ${money(line.total_cost_usd)}`
    default:
      return undefined
  }
}
