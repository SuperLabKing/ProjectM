import type PMPlugin from '#main'
import { Temporal, t } from '@dotpm/core'
import { safeAsync } from '@dotpm/ui'
import { AgendaNotices } from '#ui/agendaNavigation'
import type { WindowSource } from '#ui/agendaWindowCapture'
import { reminderTime, type AgendaItem } from '../views/agendaEntries'
import { snoozeDuration, snoozeDurationLabel } from './snoozeDuration'

const STORAGE_KEY = 'dotpm-timed-reminders-shown'
const SNOOZE_KEY = 'dotpm-reminders-snoozed'
const SNOOZE_COUNT_KEY = 'dotpm-reminders-snooze-counts'
const CHECK_MS = 5000
const MINUTE_MS = 60_000

type ReminderTarget = Pick<AgendaItem, 'path' | 'line'> & { reminderId: string }

interface TimedItem {
  id: string
  time: string
  at: number
  item: AgendaItem
}

export class TimedReminders {
  private interval: number | null = null
  private revision = 0
  private loadedRevision = -1
  private loading = false
  private scheduled: TimedItem[] = []
  private activeItems = new Map<string, AgendaItem>()
  private shown: Set<string>
  private snoozed: Map<string, number>
  private snoozeCounts = new Map<string, number>()
  private snoozeListeners = new Set<() => void>()
  private notices: AgendaNotices

  constructor(private plugin: PMPlugin) {
    const { app } = plugin
    this.notices = new AgendaNotices(plugin)
    const stored: unknown = app.loadLocalStorage(STORAGE_KEY)
    this.shown = new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [])
    const pending: unknown = app.loadLocalStorage(SNOOZE_KEY)
    this.snoozed = new Map()
    if (pending && typeof pending === 'object') {
      for (const [id, until] of Object.entries(pending)) {
        if (typeof until === 'number' && Number.isFinite(until)) this.snoozed.set(id, until)
      }
    }
    const counts: unknown = app.loadLocalStorage(SNOOZE_COUNT_KEY)
    if (counts && typeof counts === 'object') {
      for (const [id, count] of Object.entries(counts)) {
        if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) this.snoozeCounts.set(id, count)
      }
    }
  }

  start(): void {
    const { app } = this.plugin
    if (this.interval !== null) return
    const invalidate = () => this.revision++
    this.plugin.register(this.plugin.index.onChange(invalidate))
    this.plugin.registerEvent(app.metadataCache.on('resolved', invalidate))
    this.plugin.registerEvent(app.vault.on('modify', invalidate))
    this.plugin.registerEvent(app.vault.on('delete', invalidate))
    this.plugin.registerEvent(app.vault.on('rename', invalidate))
    this.interval = window.setInterval(
      safeAsync(() => this.check()),
      CHECK_MS
    )
    this.plugin.registerInterval(this.interval)
  }

  stop(): void {
    if (this.interval !== null) window.clearInterval(this.interval)
    this.interval = null
    this.revision++
    this.notices.clear()
  }

  snoozeCount(id: string | undefined): number {
    return id ? (this.snoozeCounts.get(id) ?? 0) : 0
  }

  setWindowSource(source?: WindowSource): void {
    this.notices.setWindowSource(source)
  }

  get windowSource(): WindowSource | undefined {
    return this.notices.windowSource
  }

  refreshNoticeStyle(): void {
    this.notices.syncStyle()
  }

  previewNotice(doc: Document): void {
    const minutes = snoozeDuration(this.plugin.settings.snoozeMinutes)
    this.notices.preview(doc, t('agenda.snooze', { duration: snoozeDurationLabel(minutes) }))
  }

  previewDesktopNotice(): void {
    const minutes = snoozeDuration(this.plugin.settings.snoozeMinutes)
    this.notices.previewDesktop(t('agenda.snooze', { duration: snoozeDurationLabel(minutes) }))
  }

  onSnoozeChanged(listener: () => void): () => void {
    this.snoozeListeners.add(listener)
    return () => this.snoozeListeners.delete(listener)
  }

  notifyOnce(key: string, item: ReminderTarget, message: string): void {
    if (this.shown.has(key) || this.snoozed.has(item.reminderId)) return
    this.shown.add(key)
    this.plugin.app.saveLocalStorage(STORAGE_KEY, [...this.shown])
    this.show(item, message)
  }

  private show(item: ReminderTarget, message: string): void {
    const minutes = snoozeDuration(this.plugin.settings.snoozeMinutes)
    this.notices.show(item, message, t('agenda.snooze', { duration: snoozeDurationLabel(minutes) }), () => {
      this.snoozed.set(item.reminderId, Date.now() + minutes * MINUTE_MS)
      this.saveSnoozed()
      this.snoozeCounts.set(item.reminderId, this.snoozeCount(item.reminderId) + 1)
      this.plugin.app.saveLocalStorage(SNOOZE_COUNT_KEY, Object.fromEntries(this.snoozeCounts))
      for (const listener of this.snoozeListeners) listener()
    })
  }

  private saveSnoozed(): void {
    this.plugin.app.saveLocalStorage(SNOOZE_KEY, Object.fromEntries(this.snoozed))
  }

  async check(): Promise<void> {
    if (this.interval === null || !this.plugin.index.ready || this.loading) return
    if (!this.plugin.settings.notificationsEnabled && !this.snoozed.size) return
    const revision = this.revision
    if (revision !== this.loadedRevision) {
      this.loading = true
      try {
        const terminal = new Set<string>()
        const items = await this.plugin.agendaSource.load(
          () => this.revision === revision,
          (id) => terminal.add(id)
        )
        if (this.revision !== revision) return
        const zone = Temporal.Now.timeZoneId()
        this.activeItems.clear()
        this.scheduled = items.flatMap((item) => {
          if (!item.reminderId) return []
          this.activeItems.set(item.reminderId, item)
          const when = reminderTime(item.start, item.due)
          if (!when?.time) return []
          const at = Temporal.PlainDateTime.from(`${when.day}T${when.time}`).toZonedDateTime(zone).epochMilliseconds
          return [{ id: item.reminderId, time: when.time, at, item }]
        })
        let removed = false
        for (const id of terminal) {
          if (!this.activeItems.has(id) && this.snoozed.delete(id)) removed = true
        }
        if (removed) this.saveSnoozed()
        this.loadedRevision = revision
      } finally {
        this.loading = false
      }
    }
    if (!this.plugin.settings.notificationsEnabled) return
    const now = Date.now()
    for (const [id, until] of this.snoozed) {
      if (now < until) continue
      this.snoozed.delete(id)
      this.saveSnoozed()
      const item = this.activeItems.get(id)
      if (item)
        this.show({ ...item, reminderId: id }, t('agenda.snoozedReminder', { task: item.title, source: item.source }))
    }
    for (const { id, time, at, item } of this.scheduled) {
      if (at > now || now - at >= MINUTE_MS) continue
      this.notifyOnce(
        id,
        { ...item, reminderId: id },
        t('agenda.timeReminder', { time, task: item.title, source: item.source })
      )
    }
  }
}
