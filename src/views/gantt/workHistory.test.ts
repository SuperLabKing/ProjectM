import { describe, expect, it } from 'vitest'
import { timelineChecklist, timelineNoteChecklist } from './timelineDates'
import { checklistHistoryEvents, historyDays } from './workHistory'

describe('work history', () => {
  const source = [
    { level: 'project', title: 'Delivery' },
    { level: 'task', title: 'Review' }
  ] as const
  const records = checklistHistoryEvents(
    timelineChecklist(
      [
        '- [x] Draft 计划 @ 2026-11-17 08:00~2026-11-19 16:00 开始 @ 2026-11-18 09:00 完成 @ 2026-11-20 10:15',
        '- [x] Verify 开始 @ 2026-11-19 12:00 完成 @ 2026-11-19 12:40',
        '- [x] Obsolete 取消 @ 2026-11-20 11:00',
        '- [x] Untimed 完成 @ 2026-11-20',
        '- [x] Pause 搁置 @ 2026-11-19 11:00',
        '- [ ] Future 截止 @ 2026-11-22'
      ].join('\n')
    ),
    source
  )

  it('lists only dated checklist entries and keeps their full source paths', () => {
    const days = historyDays(records, '2026-11-14', '2026-11-29')
    expect([...days.keys()]).toEqual(['2026-11-20', '2026-11-19', '2026-11-18'])
    expect(days.get('2026-11-20')).toMatchObject([
      { title: 'Obsolete', kind: 'cancellation', time: '11:00' },
      { title: 'Draft', kind: 'completion', time: '10:15', source },
      { title: 'Untimed', kind: 'completion', time: undefined }
    ])
    expect(days.get('2026-11-19')).toMatchObject([
      { title: 'Verify', time: '12:40', sameDayStart: { day: '2026-11-19', time: '12:00' } },
      { title: 'Pause', kind: 'hold', time: '11:00' }
    ])
    expect(days.get('2026-11-18')).toMatchObject([{ title: 'Draft', kind: 'start' }])
  })

  it('links both cross-day entries to the original checkbox line', () => {
    const text = '- [x] Review 开始 @ 2026-11-23 10:20 完成 @ 2026-11-24 09:30'
    const markdown = ['---', 'title: Review', '---', '', '## Notes', text, '', '## Subtasks',
      '- [ ] Footer 截止 @ 2026-11-24'].join('\r\n')
    const note = { path: 'Review.md', taskId: 'review' }
    const days = historyDays(checklistHistoryEvents(timelineNoteChecklist(markdown), source, note), '2026-11-23', '2026-11-25')
    const target = { ...note, line: 5, text }
    const start = days.get('2026-11-23')?.[0]
    const end = days.get('2026-11-24')?.[0]
    expect(start).toMatchObject({ kind: 'start', time: '10:20', target })
    expect(end).toMatchObject({ kind: 'completion', time: '09:30', target })
    expect(start?.crossDay).toBe(end?.crossDay)
    expect(start?.crossDay).toEqual({
      start: { day: '2026-11-23', time: '10:20' },
      end: { day: '2026-11-24', time: '09:30' },
      endKind: 'completion'
    })
    expect(days.get('2026-11-24')).toHaveLength(1)
  })

  it('omits plan-only entries and clips the selected period', () => {
    expect(records.map((event) => event.title)).not.toContain('Future')
    expect(records.map((event) => event.day)).not.toContain('2026-11-17')
    const days = historyDays(records, '2026-11-19', '2026-11-20')
    expect([...days.keys()]).toEqual(['2026-11-19'])
  })
})
