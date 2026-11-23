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

export interface HistoryEvent {
  day: string
  time?: string
  sameDayStart?: AgendaDate
  crossDay?: { start: AgendaDate; end: AgendaDate; endKind: Exclude<WorkHistoryStatus, 'start'> }
  target?: ChecklistTarget
  title: string
  source: readonly HistorySource[]
  kind: WorkHistoryStatus
}

export function checklistHistoryEvents(
  checklist: readonly (TimelineChecklistEntry & { text?: string })[],
  source: readonly HistorySource[],
  note?: Pick<ChecklistTarget, 'path' | 'taskId'>
): HistoryEvent[] {
  const records: HistoryEvent[] = []
  for (const check of checklist) {
    const target = note && check.text !== undefined ? { ...note, line: check.line, text: check.text } : undefined
    const context = { title: check.title, source, target }
    const { start, end, event } = check.actual
    const endKind = event ?? 'completion'
    const sameDay = start && end && start.day === end.day
    const crossDay = start && end && !sameDay ? { start, end, endKind } : undefined
    if (start && !sameDay) {
      records.push({ ...context, day: start.day, time: start.time, kind: 'start', crossDay })
    }
    if (end) {
      const sameDayStart = sameDay ? start : undefined
      records.push({ ...context, day: end.day, time: end.time, kind: endKind, sameDayStart, crossDay })
    }
  }
  return records
}

function compareHistoryTime(a: HistoryEvent, b: HistoryEvent): number {
  return (b.time ?? '').localeCompare(a.time ?? '')
}

export function historyDays(events: HistoryEvent[], first: string, last: string) {
  const days = new Map<string, HistoryEvent[]>()
  const ordered = events
    .filter((event) => event.day >= first && event.day < last)
    .sort((a, b) => b.day.localeCompare(a.day) || compareHistoryTime(a, b))
  for (const entry of ordered) {
    const list = days.get(entry.day) ?? []
    list.push(entry)
    days.set(entry.day, list)
  }
  return days
}
