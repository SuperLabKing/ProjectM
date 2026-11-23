import { Temporal } from '@dotpm/core'
import { agendaDate, readChecklistSchedule, type AgendaDate } from '../agendaEntries'

export interface TimelineDates {
  start?: AgendaDate
  end?: AgendaDate
  ongoing?: boolean
  event?: 'completion' | 'cancellation' | 'hold'
}

const checklist = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[([ /xXcC~-])\]\s*(.*)$/
const timestamp = '(\\d{4}-\\d{2}-\\d{2}(?:[ T]\\d{2}:\\d{2})?)'
const stateDate = new RegExp('(开始|进行|完成|搁置|取消)\\s*@\\s*' + timestamp, 'g')
const recordedStart = new RegExp('data-pm-start="' + timestamp + '"|始于\\s*@\\s*' + timestamp, 'g')
const clockStart = /%%dotpm-clock:\d+,\d+,(\d+)(?:,auto-(?:cancel|hold))?%%/
const stateMarks = {
  开始: 'active',
  进行: 'active',
  完成: 'done',
  搁置: 'held',
  取消: 'cancelled'
} as const

export function timelineDay(value: AgendaDate): number {
  const [hours, minutes] = (value.time ?? '0:0').split(':').map(Number)
  return Date.parse(value.day + 'T00:00:00Z') / 86_400_000 + (hours * 60 + minutes) / 1440
}

export function datesOf(start: string, end: string): TimelineDates {
  return { start: agendaDate(start), end: agendaDate(end) }
}

export interface TimelineChecklistEntry {
  line: number
  title: string
  mark: 'todo' | 'active' | 'held' | 'done' | 'cancelled'
  plan: TimelineDates
  actual: TimelineDates
}

/** Read the same scheduled syntax as Agenda and the recorded editing timestamps. */
export function timelineChecklist(description: string): TimelineChecklistEntry[] {
  const entries: TimelineChecklistEntry[] = []
  let fence: string | undefined
  for (const [line, source] of description.split(/\r?\n/).entries()) {
    const delimiter = /^\s*(?:>\s*)*(`{3,}|~{3,})(.*)$/.exec(source)
    if (delimiter && !fence) {
      fence = delimiter[1]
      continue
    }
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) {
        fence = undefined
      }
      continue
    }
    const task = checklist.exec(source)
    if (!task) continue
    const schedule = readChecklistSchedule(source, true)
    const body = task[2].replace(/%%[^\r\n]*?%%/g, (comment) =>
      comment.includes('pm-time') || comment.includes('data-pm-start') ? comment : ''
    )
    const plain = body.replace(/<[^>]*>/g, '')
    const history = [...plain.matchAll(stateDate)].flatMap(([, label, value]) => {
      const date = agendaDate(value)
      return date ? [{ label, date }] : []
    })
    const marker = task[1].toLowerCase()
    const state = history[history.length - 1]?.label as keyof typeof stateMarks | undefined
    const mark =
      (state && stateMarks[state]) ??
      schedule?.mark ??
      (marker === 'x'
        ? 'done'
        : marker === 'c' || marker === '~'
          ? 'cancelled'
          : marker === '/'
            ? 'active'
            : marker === '-'
              ? 'held'
              : 'todo')
    const start = [
      clockDate(source),
      ...history.filter(({ label }) => label === '开始' || label === '进行').map(({ date }) => date),
      ...[...body.matchAll(recordedStart)].flatMap((match) => {
        const date = agendaDate(match[1] ?? match[2])
        return date ? [date] : []
      })
    ]
      .filter((date): date is AgendaDate => !!date)
      .sort((a, b) => timelineDay(a) - timelineDay(b))[0]
    const event = [...history]
      .reverse()
      .find(
        ({ label }) =>
          (mark === 'done' && label === '完成') ||
          (mark === 'cancelled' && label === '取消') ||
          (mark === 'held' && label === '搁置')
      )
    const actual: TimelineDates = {
      start: mark === 'todo' ? undefined : start,
      end: event?.date,
      ongoing: mark === 'active' && !!start,
      event: event ? (mark === 'done' ? 'completion' : mark === 'cancelled' ? 'cancellation' : 'hold') : undefined
    }
    const stateAt = plain.search(stateDate)
    const title = schedule?.title ?? (stateAt < 0 ? plain : plain.slice(0, stateAt)).replace(/[\s*_~]+$/, '').trim()
    if (title && (schedule || actual.start || actual.end)) {
      entries.push({ line, title, mark, plan: { start: schedule?.start, end: schedule?.due }, actual })
    }
  }
  return entries
}

/** Read dated checklists at their zero-based positions in the original Markdown file. */
export function timelineNoteChecklist(markdown: string): (TimelineChecklistEntry & { text: string })[] {
  const frontmatter = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(markdown)?.[0] ?? ''
  const offset = frontmatter.split(/\r?\n/).length - 1
  const body = markdown.slice(frontmatter.length).replace(/(?:^|\r?\n)## Subtasks[ \t]*(?:\r?\n|$)[\s\S]*$/, '')
  const lines = body.split(/\r?\n/)
  return timelineChecklist(body).map((entry) => ({ ...entry, line: entry.line + offset, text: lines[entry.line] }))
}

function clockDate(line: string): AgendaDate | undefined {
  const epoch = Number(clockStart.exec(line)?.[1])
  if (!Number.isSafeInteger(epoch) || epoch <= 0 || epoch > 253_402_300_799_999) return undefined
  return agendaDate(
    Temporal.Instant.fromEpochMilliseconds(epoch)
      .toZonedDateTimeISO(Temporal.Now.timeZoneId())
      .toPlainDateTime()
      .toString({ smallestUnit: 'minute' })
  )
}

export function chartBounds(points: number[], current: number): [number, number] {
  if (!points.length) return [current - 3, current + 9]
  let start = Infinity
  let end = -Infinity
  for (const point of points) {
    start = Math.min(start, point)
    end = Math.max(end, point)
  }
  start = Math.floor(start) - 1
  const tickSpacing = Math.max(2, Math.ceil((Math.ceil(end) + 1 - start) / 6))
  return [start, start + 6 * tickSpacing]
}

export function axisDate(day: number): string {
  return new Date(Math.floor(day) * 86_400_000).toISOString().slice(0, 10)
}

export type FixedTimelineSpan = 'around7' | 'around14' | 'month' | 'quarter' | 'year'

const isBefore = (a: Temporal.PlainDate, b: Temporal.PlainDate) => Temporal.PlainDate.compare(a, b) < 0

/** Calendar windows are half-open so an event at midnight belongs to only one view. */
export function timelineWindow(span: FixedTimelineSpan, anchor: Temporal.PlainDate, offset = 0, current = anchor) {
  let first: Temporal.PlainDate
  let focus: Temporal.PlainDate
  let duration: Temporal.DurationLike
  let step: Temporal.DurationLike
  if (span === 'around7' || span === 'around14') {
    const radius = span === 'around7' ? 7 : 14
    const days = radius * 2 + 1
    focus = anchor.add({ days: days * offset })
    first = focus.subtract({ days: radius })
    duration = { days }
    step = { days: 1 }
  } else if (span === 'month') {
    first = anchor.with({ day: 1 }).add({ months: offset })
    focus = first
    duration = { months: 1 }
    step = { days: 7 }
  } else if (span === 'quarter') {
    first = anchor.with({ day: 1, month: Math.floor((anchor.month - 1) / 3) * 3 + 1 }).add({ months: offset * 3 })
    focus = first
    duration = { months: 3 }
    step = { months: 1 }
  } else {
    first = anchor.with({ month: 1, day: 1 }).add({ years: offset })
    focus = first
    duration = { years: 1 }
    step = { months: 1 }
  }
  let last = first.add(duration)
  if (!isBefore(current, first) && isBefore(current, last)) {
    if (span === 'month') {
      const before = current.subtract({ days: 7 })
      const after = current.add({ days: 8 })
      if (isBefore(before, first)) first = before
      if (isBefore(last, after)) last = after
    } else if (span === 'year') {
      if (current.month === 1) first = first.subtract({ months: 1 })
      if (current.month === 12) last = last.add({ months: 1 })
    }
  }
  const dayNumber = (date: Temporal.PlainDate) => timelineDay({ day: date.toString() })
  const ticks: number[] = []
  for (let date = first; Temporal.PlainDate.compare(date, last) < 0; date = date.add(step)) {
    ticks.push(dayNumber(date))
  }
  return { start: dayNumber(first), end: dayNumber(last), ticks, focus }
}
