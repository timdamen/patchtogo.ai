import type { Notification, Notifier } from '../../src/pipeline/ports.ts'

export class RecordingNotifier implements Notifier {
  readonly notifications: Notification[] = []
  #failure: Error | undefined

  failNext(error = new Error('the reviewer channel is down')): void {
    this.#failure = error
  }

  notify(notification: Notification): Promise<void> {
    const failure = this.#failure
    this.#failure = undefined
    if (failure) return Promise.reject(failure)
    this.notifications.push(structuredClone(notification))
    return Promise.resolve()
  }
}
