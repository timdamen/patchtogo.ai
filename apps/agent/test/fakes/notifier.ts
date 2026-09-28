import type { Notification, Notifier } from '../../src/pipeline/ports.ts'

export class RecordingNotifier implements Notifier {
  readonly notifications: Notification[] = []

  notify(notification: Notification): Promise<void> {
    this.notifications.push(structuredClone(notification))
    return Promise.resolve()
  }
}
