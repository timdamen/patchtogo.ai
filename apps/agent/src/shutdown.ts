export interface ShutdownLog {
  info(message: string): void
  error(details: object, message: string): void
}

export interface GracefulExitOptions {
  deadlineMs: number
  log: ShutdownLog
  close(): Promise<void>
}

export function exitGracefully({ deadlineMs, log, close }: GracefulExitOptions): void {
  let closing = false

  async function stop(reason: string, code: number) {
    if (closing) {
      if (code !== 0) process.exit(code)
      return
    }
    closing = true
    log.info(`${reason}: shutting down`)
    setTimeout(() => {
      log.error({ deadlineMs }, `${reason}: shutdown missed its deadline`)
      process.exit(1)
    }, deadlineMs)
    try {
      await close()
    } catch (error) {
      log.error({ err: error }, `${reason}: shutdown failed`)
      process.exit(1)
    }
    process.exit(code)
  }

  process.on('SIGTERM', () => void stop('SIGTERM', 0))
  process.on('SIGINT', () => void stop('SIGINT', 0))
  process.on('uncaughtException', (error) => {
    log.error({ err: error }, 'uncaught exception')
    void stop('uncaught exception', 1)
  })
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandled rejection')
    void stop('unhandled rejection', 1)
  })
}
