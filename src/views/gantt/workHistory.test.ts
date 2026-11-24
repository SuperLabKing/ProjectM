import { describe, expect, it } from 'vitest'
import { timelineChecklist, timelineNoteChecklist } from './timelineDates'
import { checklistHistoryEvents, historyDays, nextHistoryOccurrence } from './workHistory'

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
    expect(start?.related?.entries).toBe(end?.related?.entries)
    expect(start?.related?.entries).toMatchObject([
      { day: '2026-11-23', time: '10:20', kind: 'start' },
      { day: '2026-11-24', time: '09:30', kind: 'completion' }
    ])
    expect(days.get('2026-11-24')).toHaveLength(1)
  })

  it('cycles through all retained cross-day statuses without mixing identically titled checkboxes', () => {
    const entries = timelineNoteChecklist([
      '- [x] Review 完成 @ 2026-11-25 10:00 开始 @ 2026-11-22 16:20 搁置 @ 2026-11-23 13:20 进行 @ 2026-11-24 09:00',
      '- [x] Review 开始 @ 2026-11-22 16:20 取消 @ 2026-11-25 11:00'
    ].join('\n'))
    const records = checklistHistoryEvents(entries, source, { path: 'Review.md', taskId: 'review' })
    const first = records.filter(record => record.target?.line === 0)
    const second = records.filter(record => record.target?.line === 1)
    const links = first.flatMap(record => record.related ? [record.related] : [])
    expect(first.map(record => record.kind)).toEqual(['start', 'hold', 'start', 'completion'])
    expect(links.map(link => nextHistoryOccurrence(link).kind)).toEqual(['hold', 'start', 'completion', 'start'])
    expect(links.every(link => link.entries === links[0].entries)).toBe(true)
    expect(second[0]?.related?.entries).not.toBe(links[0].entries)
  })

  it('omits plan-only entries and clips the selected period', () => {
    expect(records.map((event) => event.title)).not.toContain('Future')
    expect(records.map((event) => event.day)).not.toContain('2026-11-17')
    const days = historyDays(records, '2026-11-19', '2026-11-20')
    expect([...days.keys()]).toEqual(['2026-11-19'])
  })

  it('sorts day groups and times together and keeps date-only entries last within a day', () => {
    const ascending = historyDays(records, '2026-11-18', '2026-11-21', 'asc')
    const descending = historyDays(records, '2026-11-18', '2026-11-21', 'desc')
    expect([...ascending.keys()]).toEqual(['2026-11-18', '2026-11-19', '2026-11-20'])
    expect([...descending.keys()]).toEqual(['2026-11-20', '2026-11-19', '2026-11-18'])
    expect(ascending.get('2026-11-20')?.map(entry => entry.time)).toEqual(['10:15', '11:00', undefined])
    expect(descending.get('2026-11-20')?.map(entry => entry.time)).toEqual(['11:00', '10:15', undefined])
  })
})
