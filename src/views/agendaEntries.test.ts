import { describe, expect, it } from 'vitest'
import { Temporal } from '@dotpm/core'
import { agendaEntries, readChecklistSchedule, reminderTime, type AgendaItem } from './agendaEntries'

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

  it('chooses a single reminder time and ignores dates without a time', () => {
    const start = { day: '2026-11-15', time: '09:00' }
    const due = { day: '2026-11-15', time: '11:30' }
    expect(reminderTime(start, due)).toBe(start)
    expect(reminderTime({ day: start.day }, due)).toBe(due)
    expect(reminderTime({ day: start.day }, { day: due.day })).toBeUndefined()
  })
})
