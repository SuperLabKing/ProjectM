import { DEFAULT_WORK_HISTORY_STATUS_COLORS, readColor, type PMSettings, type WorkHistoryStatus } from '@dotpm/core'
import type { AgendaDate } from '../agendaEntries'
import type { TimelineChecklistEntry } from './timelineDates'

export const workHistoryKinds = {
  start: { label: 'status.inProgress', icon: 'pause' },
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

export interface HistoryEvent {
  day: string
  time?: string
  firstStart?: AgendaDate
  kind: WorkHistoryStatus
  target?: ChecklistTarget
  details?: { markdown: string; sourcePath: string }
  title: string
  source: readonly HistorySource[]
}

export function checklistHistoryEvents(
  checklist: readonly (TimelineChecklistEntry & { text?: string })[],
  source: readonly HistorySource[],
  note?: Pick<ChecklistTarget, 'path' | 'taskId'>,
  sourcePath = note?.path ?? ''
): HistoryEvent[] {
  const records: HistoryEvent[] = []
  for (const check of checklist) {
    const { start, end, ongoing, event } = check.actual
    const date = ongoing ? start : end
    const kind = ongoing ? 'start' : event
    if (!date || !kind) continue
    const target = note && check.text !== undefined ? { ...note, line: check.line, text: check.text } : undefined
    const details = check.details ? { markdown: check.details, sourcePath } : undefined
    records.push({ ...date, kind, firstStart: ongoing ? undefined : start, title: check.title, source, target, details })
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
