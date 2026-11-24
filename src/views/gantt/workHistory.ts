import { DEFAULT_WORK_HISTORY_STATUS_COLORS, readColor, type PMSettings, type WorkHistoryStatus } from '@dotpm/core'
import type { AgendaDate } from '../agendaEntries'
import type { TimelineChecklistEntry } from './timelineDates'

export const workHistoryKinds = {
  start: { label: 'workHistory.started', icon: 'pause' },
  completion: { label: 'projectTimeline.completed', icon: 'check' },
  hold: { label: 'projectTimeline.held', icon: 'play' },
  cancellation: { label: 'projectTimeline.cancelled', icon: 'x' }
} as const satisfies Record<WorkHistoryStatus, { label: string; icon: string }>

export function workHistoryStatusColor(colors: PMSettings['workHistoryStatusColors'], kind: WorkHistoryStatus): string {
  return readColor(colors?.[kind]) ?? DEFAULT_WORK_HISTORY_STATUS_COLORS[kind]
}

export type HistoryLevel = 'project' | 'subproject' | 'task' | 'subtask'

export interface HistorySource {
  title: string
  level: HistoryLevel
}

export interface ChecklistTarget {
  path: string
  taskId: string
  line: number
  text: string
}

export interface HistoryOccurrence {
  day: string
  time?: string
  sameDayStart?: AgendaDate
  kind: WorkHistoryStatus
}

export interface HistoryEvent extends HistoryOccurrence {
  related?: { entries: readonly HistoryOccurrence[]; index: number }
  target?: ChecklistTarget
  title: string
  source: readonly HistorySource[]
}

export function nextHistoryOccurrence({ entries, index }: NonNullable<HistoryEvent['related']>): HistoryOccurrence {
  return entries[(index + 1) % entries.length]
}

export function checklistHistoryEvents(
  checklist: readonly (TimelineChecklistEntry & { text?: string })[],
  source: readonly HistorySource[],
  note?: Pick<ChecklistTarget, 'path' | 'taskId'>
): HistoryEvent[] {
  const records: HistoryEvent[] = []
  for (const check of checklist) {
    const target = note && check.text !== undefined ? { ...note, line: check.line, text: check.text } : undefined
    const timeKey = ({ date, kind }: (typeof check.history)[number]) =>
      date.time ?? (kind === 'start' ? '' : '24:00')
    const stamps = [...check.history].sort((a, b) =>
      a.date.day.localeCompare(b.date.day) || timeKey(a).localeCompare(timeKey(b))
    )
    const entries: HistoryOccurrence[] = []
    const seen = new Set<string>()
    for (const { date, kind } of stamps) {
      const key = `${date.day}/${date.time ?? ''}/${kind}`
      if (seen.has(key)) continue
      seen.add(key)
      const previous = entries.at(-1)
      let sameDayStart: AgendaDate | undefined
      if (kind !== 'start' && previous?.kind === 'start' && previous.day === date.day) {
        sameDayStart = { day: previous.day, time: previous.time }
        entries.pop()
      }
      entries.push({ ...date, kind, sameDayStart })
    }
    const crossDay = entries[0]?.day !== entries.at(-1)?.day
    entries.forEach((entry, index) => records.push({
      ...entry, title: check.title, source, target, related: crossDay ? { entries, index } : undefined
    }))
  }
  return records
}

export type HistorySortOrder = 'asc' | 'desc'

export function historyDays(events: readonly HistoryEvent[], first: string, last: string, order: HistorySortOrder = 'desc') {
  const days = new Map<string, HistoryEvent[]>()
  const direction = order === 'asc' ? 1 : -1
  const ordered = events
    .filter((event) => event.day >= first && event.day < last)
    .sort((a, b) => {
      const day = a.day.localeCompare(b.day)
      if (day) return day * direction
      if (!a.time || !b.time) return Number(!a.time) - Number(!b.time)
      return a.time.localeCompare(b.time) * direction
    })
  for (const entry of ordered) {
    const list = days.get(entry.day) ?? []
    list.push(entry)
    days.set(entry.day, list)
  }
  return days
}
