import { agendaDate, type AgendaDate } from '../agendaEntries'
import { datesOf, type TimelineChecklistEntry, type TimelineDates } from './timelineDates'

type HistoryKind = 'start' | 'completion' | 'cancellation' | 'hold' | 'planStart' | 'planEnd' | 'planRange'

export interface HistoryEvent {
  sourceKey: string
  day: string
  time?: string
  endTime?: string
  title: string
  project: string
  task?: string
  kind: HistoryKind
  planned: boolean
  children?: HistoryEvent[]
}

export interface HistoryTask {
  sourceKey: string
  project: string
  title: string
  start: string
  due: string
  completed: string
  cancelled: boolean
  checklist: TimelineChecklistEntry[]
}

function collectEvents(
  target: HistoryEvent[],
  context: Pick<HistoryEvent, 'sourceKey' | 'title' | 'project' | 'task'>,
  dates: TimelineDates,
  planned: boolean
): void {
  const { start, end } = dates
  const endKind = planned ? 'planEnd' : (dates.event ?? 'completion')
  const record = (date: AgendaDate, kind: HistoryKind, endTime?: string) => {
    target.push({ ...context, day: date.day, time: date.time, endTime, kind, planned })
  }
  if (start && end && start.day === end.day && start.time && end.time && start.time <= end.time) {
    record(start, planned ? 'planRange' : endKind, end.time)
    return
  }
  if (start) record(start, planned ? 'planStart' : 'start')
  if (end) record(end, endKind)
}

export function historyEvents(task: HistoryTask): HistoryEvent[] {
  const records: HistoryEvent[] = []
  const context = { sourceKey: task.sourceKey, title: task.title, project: task.project }
  collectEvents(records, context, datesOf(task.start, task.due), true)
  const completion = agendaDate(task.completed)
  if (completion) {
    collectEvents(
      records,
      context,
      {
        end: completion,
        event: task.cancelled ? 'cancellation' : 'completion'
      },
      false
    )
  }
  const taskCompletion = records.find((item) => item.kind === 'completion')
  for (const check of task.checklist) {
    const checkContext = { ...context, title: check.title, task: task.title }
    collectEvents(records, checkContext, check.plan, true)
    const actual: HistoryEvent[] = []
    collectEvents(actual, checkContext, check.actual, false)
    for (const event of actual) {
      if (event.kind === 'completion' && taskCompletion?.day === event.day) {
        ;(taskCompletion.children ??= []).push(event)
      } else {
        records.push(event)
      }
    }
  }
  if (taskCompletion?.children) taskCompletion.children.sort(compareHistoryTime)
  return records
}

function compareHistoryTime(a: HistoryEvent, b: HistoryEvent): number {
  return (a.time ?? '').localeCompare(b.time ?? '') || Number(a.planned) - Number(b.planned)
}

export function historyDays(events: HistoryEvent[], first: string, last: string, includePlans: boolean) {
  const days = new Map<string, HistoryEvent[]>()
  const ordered = events
    .filter((event) => event.day >= first && event.day < last && (includePlans || !event.planned))
    .sort((a, b) => b.day.localeCompare(a.day) || compareHistoryTime(a, b))
  for (const entry of ordered) {
    const list = days.get(entry.day) ?? []
    list.push(entry)
    days.set(entry.day, list)
  }
  return days
}
