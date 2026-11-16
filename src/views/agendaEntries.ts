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
      sections[day === current ? 'today' : 'upcoming'].push({
        item,
        day,
        start: start?.day === day ? start : undefined,
        due: due?.day === day ? due : undefined
      })
    }
  }
  for (const list of Object.values(sections)) {
    list.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        (a.start?.time ?? a.due?.time ?? '').localeCompare(b.start?.time ?? b.due?.time ?? '') ||
        a.item.title.localeCompare(b.item.title)
    )
  }
  return sections
}
