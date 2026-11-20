import { parsePlainDate, type Temporal } from '@dotpm/core'

export interface AgendaDate {
  day: string
  time?: string
}

export interface AgendaItem {
  reminderId?: string
  title: string
  path: string
  source: string
  status: string
  statusTone?: 'todo' | 'active' | 'held'
  start?: AgendaDate
  due?: AgendaDate
  line?: number
}

export interface AgendaEntry {
  item: AgendaItem
  day: string
  start?: AgendaDate
  due?: AgendaDate
  overdueDays?: number
}

const dateWithTime = /^(\d{4}-\d{2}-\d{2})(?:[ T]((?:[01]\d|2[0-3]):[0-5]\d))?$/
const planned =
  /(?:计划|截止)\s*@\s*(~?\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?(?:\s*~\s*(?:\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?|\d{2}:\d{2}))?)(?![\d:])/g
const checkbox = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[([ /xXcC~-])\]\s*(.*)$/

export function agendaDate(text: string): AgendaDate | undefined {
  const match = dateWithTime.exec(text)
  return match && parsePlainDate(match[1]) ? { day: match[1], time: match[2] } : undefined
}

export function readChecklistSchedule(
  text: string,
  includeTerminal = false
):
  | (Omit<AgendaItem, 'path' | 'source' | 'line' | 'status'> & {
      mark: 'todo' | 'active' | 'held' | 'done' | 'cancelled'
    })
  | undefined {
  const task = checkbox.exec(text)
  if (!task) return
  const marker = task[1].toLowerCase()
  const terminal = marker === 'x' ? 'done' : marker === 'c' || marker === '~' ? 'cancelled' : undefined
  if (terminal && !includeTerminal) return
  const body = task[2].replace(/<[^>]*>/g, '')
  const plan = [...body.matchAll(planned)].at(-1)
  if (!plan) return
  const [first = '', second] = plan[1].split(/\s*~\s*/)
  const deadlineOnly = plan[0].startsWith('截止')
  const start = deadlineOnly ? undefined : agendaDate(first)
  const due = second
    ? agendaDate(second.length === 5 && start ? `${start.day} ${second}` : second)
    : deadlineOnly
      ? agendaDate(first)
      : undefined
  if ((!start && !due) || (second && !due)) return
  const title = body
    .slice(0, plan.index)
    .replace(/\s*%%[^\r\n]*?%%/g, '')
    .replace(/[\s*_~]+$/, '')
    .trim()
  if (!title) return
  return { title, start, due, mark: terminal ?? (marker === '/' ? 'active' : marker === '-' ? 'held' : 'todo') }
}

export function reminderTime(start?: AgendaDate, due?: AgendaDate): AgendaDate | undefined {
  return start?.time ? start : due?.time ? due : undefined
}

function entryOnDay(item: AgendaItem, day: string): AgendaEntry {
  return {
    item,
    day,
    start: item.start?.day === day ? item.start : undefined,
    due: item.due?.day === day ? item.due : undefined
  }
}

function compareEntries(a: AgendaEntry, b: AgendaEntry): number {
  return (
    a.day.localeCompare(b.day) ||
    (a.start?.time ?? a.due?.time ?? '').localeCompare(b.start?.time ?? b.due?.time ?? '') ||
    a.item.title.localeCompare(b.item.title)
  )
}

type WeekEntry = AgendaEntry & { slot?: { start: number; end?: number } }

const DAY_MINUTES = 24 * 60

function minuteOfDay(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
}

export function agendaWeekEntries(items: AgendaItem[], current: Temporal.PlainDate) {
  const today = current.toString()
  const monday = current.subtract({ days: current.dayOfWeek - 1 })
  const week = Array.from({ length: 7 }, (_, index) => {
    const day = monday.add({ days: index })
    return { day, date: day.toString(), entries: [] as WeekEntry[] }
  })
  for (const item of items) {
    const { start, due } = item
    const interval = start?.time && due?.time ? { start, due } : undefined
    for (const { date, day, entries } of week) {
      const spanning = interval && interval.start.day <= date && interval.due.day >= date
      if (!spanning && date !== start?.day && date !== due?.day) continue
      const entry: WeekEntry = entryOnDay(item, date)
      if (entry.due && date < today) entry.overdueDays = day.until(current).days
      const timestamp = entry.start?.time ?? entry.due?.time
      if (spanning) {
        const from = interval.start.day === date ? minuteOfDay(interval.start.time!) : 0
        const to = interval.due.day === date ? minuteOfDay(interval.due.time!) : DAY_MINUTES
        entry.slot = { start: from, end: to > from ? to : undefined }
      } else if (timestamp) {
        entry.slot = { start: minuteOfDay(timestamp) }
      }
      entries.push(entry)
    }
  }
  for (const { entries } of week)
    entries.sort((a, b) => (a.slot?.start ?? -1) - (b.slot?.start ?? -1) || compareEntries(a, b))
  return week
}

export function arrangeWeekSlots(entries: WeekEntry[]) {
  const layout: { entry: WeekEntry; start: number; end?: number; lane: number; lanes: number }[] = []
  const laneEnds: number[] = []
  let groupStart = 0
  const closeGroup = () => {
    for (let index = groupStart; index < layout.length; index++) layout[index].lanes = laneEnds.length
  }
  for (const entry of entries) {
    if (!entry.slot) continue
    const { start, end } = entry.slot
    if (laneEnds.every((finish) => finish <= start)) {
      closeGroup()
      groupStart = layout.length
      laneEnds.length = 0
    }
    const available = laneEnds.findIndex((finish) => finish <= start)
    const lane = available < 0 ? laneEnds.length : available
    // Point events reserve space for their label without implying a duration.
    laneEnds[lane] = end ?? start + 30
    layout.push({ entry, start, end, lane, lanes: 1 })
  }
  closeGroup()
  return layout
}

export function agendaEntries(items: AgendaItem[], today: Temporal.PlainDate) {
  const current = today.toString()
  const limit = today.add({ days: 7 }).toString()
  const sections: Record<'overdue' | 'today' | 'upcoming', AgendaEntry[]> = { overdue: [], today: [], upcoming: [] }
  for (const item of items) {
    const { start, due } = item
    if (due && due.day < current) {
      const deadline = parsePlainDate(due.day)
      if (deadline) sections.overdue.push({ item, day: due.day, due, overdueDays: deadline.until(today).days })
      continue
    }
    const days = new Set([start?.day, due?.day])
    for (const day of days) {
      if (!day || day < current || day > limit) continue
      sections[day === current ? 'today' : 'upcoming'].push(entryOnDay(item, day))
    }
  }
  for (const list of Object.values(sections)) list.sort(compareEntries)
  return sections
}
