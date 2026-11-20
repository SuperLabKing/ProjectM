import { describe, expect, it } from 'vitest'
import { Temporal } from '@dotpm/core'
import {
  agendaEntries,
  agendaWeekEntries,
  arrangeWeekSlots,
  readChecklistSchedule,
  reminderTime,
  type AgendaItem
} from './agendaEntries'

describe('schedule reminders', () => {
  it('reads the picker formats and skips completed and cancelled checkboxes', () => {
    expect(readChecklistSchedule('- [/] 测序 计划 @ 2026-11-15 09:00~11:30')).toMatchObject({
      title: '测序',
      mark: 'active',
      start: { day: '2026-11-15', time: '09:00' },
      due: { day: '2026-11-15', time: '11:30' }
    })
    expect(readChecklistSchedule('- [-] 搁置记录 计划 @ ~2026-11-16')).toMatchObject({
      mark: 'held',
      start: undefined,
      due: { day: '2026-11-16' }
    })
    for (const mark of ['x', 'X', 'c', '~']) {
      expect(readChecklistSchedule(`- [${mark}] 已处理 计划 @ ~2026-11-15`)).toBeUndefined()
    }
    expect(readChecklistSchedule('- [ ] 非法日期 计划 @ ~2026-02-30')).toBeUndefined()
  })

  it('uses calendar days for overdue, groups same-day dates, and never treats a past start as a deadline', () => {
    const item = (title: string, start?: string, due?: string): AgendaItem => ({
      title,
      source: 'test',
      status: 'todo',
      path: title + '.md',
      start: start ? { day: start } : undefined,
      due: due ? { day: due } : undefined
    })
    const sections = agendaEntries(
      [
        item('start only', '2026-11-13'),
        item('expired range', '2026-11-12', '2026-11-14'),
        item('today range', '2026-11-15', '2026-11-15'),
        item('upcoming', undefined, '2026-11-22'),
        item('later', undefined, '2026-11-23')
      ],
      Temporal.PlainDate.from('2026-11-15')
    )
    expect(sections.overdue.map(({ item, overdueDays }) => [item.title, overdueDays])).toEqual([['expired range', 1]])
    expect(sections.today).toHaveLength(1)
    expect(sections.today[0]).toMatchObject({
      start: { day: '2026-11-15' },
      due: { day: '2026-11-15' }
    })
    expect(sections.upcoming.map(({ item }) => item.title)).toEqual(['upcoming'])
  })

  it('puts starts and deadlines in the Monday-to-Sunday week, including recent overdue deadlines', () => {
    const item = { title: 'weekly', path: 'week.md', source: 'test', status: 'todo' }
    const week = agendaWeekEntries(
      [
        { ...item, start: { day: '2026-11-16', time: '09:00' }, due: { day: '2026-11-16', time: '11:00' } },
        { ...item, start: { day: '2026-11-15' }, due: { day: '2026-11-18' } },
        { ...item, start: { day: '2026-11-22' }, due: { day: '2026-11-23' } }
      ],
      Temporal.PlainDate.from('2026-11-19')
    )
    expect(week.map(({ day }) => day.day)).toEqual([16, 17, 18, 19, 20, 21, 22])
    expect(week.map(({ entries }) => entries.length)).toEqual([1, 0, 1, 0, 0, 0, 1])
    expect(week[0].entries[0]).toMatchObject({ start: { time: '09:00' }, due: { time: '11:00' }, overdueDays: 3 })
    expect(week[2].entries[0]).toMatchObject({ start: undefined, due: { day: '2026-11-18' }, overdueDays: 1 })
    expect(week[6].entries[0]).toMatchObject({ start: { day: '2026-11-22' }, due: undefined })
  })

  it('splits an overnight interval by day and separates overlapping time blocks', () => {
    const base = { title: 'night', path: 'week.md', source: 'test', status: 'todo' }
    const week = agendaWeekEntries(
      [
        { ...base, start: { day: '2026-11-16', time: '23:30' }, due: { day: '2026-11-17', time: '01:15' } },
        {
          ...base,
          title: 'review',
          start: { day: '2026-11-17', time: '00:30' },
          due: { day: '2026-11-17', time: '01:30' }
        },
        { ...base, title: 'deadline', due: { day: '2026-11-17', time: '02:00' } },
        { ...base, title: 'all day', start: { day: '2026-11-17' } }
      ],
      Temporal.PlainDate.from('2026-11-16')
    )
    expect(week[0].entries[0].slot).toEqual({ start: 1410, end: 1440 })
    expect(week[1].entries[0].slot).toBeUndefined()
    expect(arrangeWeekSlots(week[1].entries).map(({ start, end, lane, lanes }) => [start, end, lane, lanes])).toEqual([
      [0, 75, 0, 2],
      [30, 90, 1, 2],
      [120, undefined, 0, 1]
    ])
  })

  it('chooses a single reminder time and ignores dates without a time', () => {
    const start = { day: '2026-11-15', time: '09:00' }
    const due = { day: '2026-11-15', time: '11:30' }
    expect(reminderTime(start, due)).toBe(start)
    expect(reminderTime({ day: start.day }, due)).toBe(due)
    expect(reminderTime({ day: start.day }, { day: due.day })).toBeUndefined()
  })
})
