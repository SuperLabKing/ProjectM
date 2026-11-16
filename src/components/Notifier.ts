import type PMPlugin from '#main'
import { Temporal, today, parsePlainDate, t, tn } from '@dotpm/core'
import { agendaDate, reminderTime } from '../views/agendaEntries'

const CHECK_INTERVAL_MS = 60 * 60 * 1000

export class Notifier {
  private intervalId: number | null = null

  constructor(private plugin: PMPlugin) {}

  /** The first sweep runs once the index is built; this only schedules the later ones. */
  start(): void {
    this.intervalId = window.setInterval(() => {
      this.check()
    }, CHECK_INTERVAL_MS)
    this.plugin.registerInterval(this.intervalId)
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /** Reads due dates from the index, so an hourly sweep loads nothing. */
  check(): void {
    if (!this.plugin.settings.notificationsEnabled) return

    const leadDays = this.plugin.settings.notificationLeadDays
    const now = today()
    const threshold = now.add({ days: leadDays })

    for (const project of this.plugin.index.projectRefs()) {
      const complete = this.plugin.index.completeStatuses(project)
      for (const task of this.plugin.index.taskRefs(project.path)) {
        if (reminderTime(agendaDate(task.start), agendaDate(task.due))) continue
        const due = parsePlainDate(task.due)
        if (!due) continue
        if (task.archived || complete.has(task.status)) continue

        const cmpToToday = Temporal.PlainDate.compare(due, now)
        const isOverdue = cmpToToday < 0
        const isDueSoon = cmpToToday >= 0 && Temporal.PlainDate.compare(due, threshold) <= 0

        const notifKey = `due:${task.id}:${task.due}`
        const target = { path: task.path, reminderId: `task:${task.id}` }

        if (isOverdue) {
          const daysAgo = now.since(due, { largestUnit: 'days' }).days
          this.plugin.timedReminders.notifyOnce(
            notifKey,
            target,
            tn('notify.overdue', daysAgo, { task: task.title, project: project.title })
          )
        } else if (isDueSoon) {
          const daysLeft = due.since(now, { largestUnit: 'days' }).days
          const names = { task: task.title, project: project.title }
          const msg = daysLeft === 0 ? t('notify.dueToday', names) : tn('notify.dueIn', daysLeft, names)
          this.plugin.timedReminders.notifyOnce(notifKey, target, msg)
        }
      }
    }
  }
}
