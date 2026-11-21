import { describe, expect, it } from 'vitest'
import { Temporal } from '@dotpm/core'
import { axisDate, timelineChecklist, timelineDay, timelineWindow } from './timelineDates'

describe('project timeline checklist dates', () => {
  it('keeps plan dates separate and reads current state from the timestamp on checked items', () => {
    const entries = timelineChecklist(
      [
        '- [x] Work 计划 @ 2026-11-14 09:00~10:30 开始 @ 2026-11-15 09:15',
        '- [x] Review 截止 @ 2026-11-17 完成 @ 2026-11-18 10:00',
        '- [x] Drop 取消 @ 2026-11-19 10:00',
        '- [x] Pause 搁置 @ 2026-11-20 11:00（始于 @ 2026-11-19 10:10）'
      ].join('\n')
    )
    expect(entries.map(({ title, mark }) => [title, mark])).toEqual([
      ['Work', 'active'],
      ['Review', 'done'],
      ['Drop', 'cancelled'],
      ['Pause', 'held']
    ])
    expect(entries[0].plan).toMatchObject({ start: { day: '2026-11-14', time: '09:00' }, end: { time: '10:30' } })
    expect(entries[0].actual).toMatchObject({ start: { day: '2026-11-15', time: '09:15' }, ongoing: true })
    expect(entries[1].plan.start).toBeUndefined()
    expect(entries[1].actual).toMatchObject({ end: { day: '2026-11-18' }, event: 'completion' })
    expect(entries[2].actual).toMatchObject({ end: { day: '2026-11-19' }, event: 'cancellation' })
    expect(entries[3].actual.start).toEqual({ day: '2026-11-19', time: '10:10' })
  })

  it('reads the original clock start and skips undated and fenced examples', () => {
    const start = new Date(2026, 10, 14, 9, 12).valueOf()
    const entries = timelineChecklist(
      [
        '- [ ] No dates',
        '```markdown',
        '- [ ] Example 截止 @ 2026-11-30',
        '```',
        '- [x] Finished %%dotpm-clock:0,42,' + start + '%% 完成 @ 2026-11-16 15:00'
      ].join('\n')
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      line: 4,
      title: 'Finished',
      plan: {},
      actual: {
        start: { day: '2026-11-14', time: '09:12' },
        end: { day: '2026-11-16', time: '15:00' }
      }
    })
    expect(timelineDay({ day: '2026-11-16', time: '12:00' }) - timelineDay({ day: '2026-11-16' })).toBe(0.5)
  })
})

describe('timeline calendar spans', () => {
  it('aligns periods and moves between them without gaps', () => {
    const date = Temporal.PlainDate.from('2026-11-21')
    const expected = {
      around7: ['2026-11-14', '2026-11-29', 15],
      around14: ['2026-11-07', '2026-12-06', 29],
      month: ['2026-11-01', '2026-12-01', 5],
      quarter: ['2026-10-01', '2027-01-01', 3],
      year: ['2026-01-01', '2027-01-01', 12]
    } as const
    for (const span of ['around7', 'around14', 'month', 'quarter', 'year'] as const) {
      const window = timelineWindow(span, date)
      expect([axisDate(window.start), axisDate(window.end), window.ticks.length]).toEqual(expected[span])
      if (span === 'around7' || span === 'around14') {
        expect(window.ticks).toEqual(
          Array.from({ length: window.end - window.start }, (_, index) => window.start + index)
        )
      }
      expect(timelineWindow(span, date, -1).end).toBe(window.start)
      expect(timelineWindow(span, date, 1).start).toBe(window.end)
    }
  })

  it('adds context at the current period boundaries and keeps pagination calendar-based', () => {
    const bounds = (span: 'month' | 'year', text: string, offset = 0) => {
      const window = timelineWindow(span, Temporal.PlainDate.from(text), offset)
      return [axisDate(window.start), axisDate(window.end), window.focus.toString()]
    }
    expect(bounds('month', '2026-11-02')).toEqual(['2026-10-26', '2026-12-01', '2026-11-01'])
    expect(bounds('month', '2026-11-29')).toEqual(['2026-11-01', '2026-12-07', '2026-11-01'])
    expect(bounds('month', '2026-11-02', -1)).toEqual(['2026-10-01', '2026-11-01', '2026-10-01'])
    expect(bounds('year', '2026-01-02')).toEqual(['2025-12-01', '2027-01-01', '2026-01-01'])
    expect(bounds('year', '2026-12-12')).toEqual(['2026-01-01', '2027-02-01', '2026-01-01'])
  })
})
