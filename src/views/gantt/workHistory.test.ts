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
    expect([...days.keys()]).toEqual(['2026-11-20', '2026-11-19'])
    expect(days.get('2026-11-20')).toMatchObject([
      { title: 'Obsolete', kind: 'cancellation', time: '11:00' },
      { title: 'Draft', kind: 'completion', time: '10:15', source },
      { title: 'Untimed', kind: 'completion', time: undefined }
    ])
    expect(days.get('2026-11-19')).toMatchObject([
      { title: 'Verify', time: '12:40', firstStart: { day: '2026-11-19', time: '12:00' } },
      { title: 'Pause', kind: 'hold', time: '11:00' }
    ])
  })

  it('retains the original checkbox link and first start on a cross-day completion', () => {
    const text = '- [x] Review 开始 @ 2026-11-23 10:20 完成 @ 2026-11-24 09:30'
    const markdown = ['---', 'title: Review', '---', '', '## Notes', text, '', '## Subtasks',
      '- [ ] Footer 截止 @ 2026-11-24'].join('\r\n')
    const note = { path: 'Review.md', taskId: 'review' }
    const days = historyDays(checklistHistoryEvents(timelineNoteChecklist(markdown), source, note), '2026-11-23', '2026-11-25')
    const target = { ...note, line: 5, text }
    expect(days.get('2026-11-23')).toBeUndefined()
    expect(days.get('2026-11-24')).toMatchObject([
      { kind: 'completion', time: '09:30', target, firstStart: { day: '2026-11-23', time: '10:20' } }
    ])
  })

  it('moves a checkbox between its first start and current terminal state', () => {
    const start = new Date(2026, 10, 22, 16, 20).getTime()
    const states = [
      ['开始 @ 2026-11-22 16:20', 'start', '2026-11-22'],
      ['搁置 @ 2026-11-23 13:20', 'hold', '2026-11-23'],
      ['开始 @ 2026-11-24 09:00', 'start', '2026-11-22'],
      ['完成 @ 2026-11-24 20:18', 'completion', '2026-11-24'],
      ['取消 @ 2026-11-25 11:00', 'cancellation', '2026-11-25']
    ] as const
    for (const [stamp, kind, day] of states) {
      const line = `- [x] Review %%dotpm-clock:0,1000,${start}%% ${stamp}`
      const events = checklistHistoryEvents(timelineNoteChecklist(line), source)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ day, kind })
      expect(events[0].firstStart).toEqual(kind === 'start' ? undefined : { day: '2026-11-22', time: '16:20' })
    }
  })

  it('keeps continuation details without absorbing sibling or child checklist records', () => {
    const markdown = [
      '---', 'title: Review', '---',
      '- [x] Review 开始 @ 2026-11-23 09:00 完成 @ 2026-11-24 10:00',
      '  Checked the contact sheet.',
      '  ![[sheet.png]]',
      '  - [[Summary|See the summary]]',
      '    - A nested note',
      '  - [x] Child 完成 @ 2026-11-24 09:30',
      '    Child-only notes',
      '  Parent conclusion.',
      '- [x] Sibling 完成 @ 2026-11-24 11:00',
      '  %% internal comment %%',
      '## Subtasks',
      '  This is outside the task body.'
    ].join('\r\n')
    const note = { path: 'Demo/Review.md', taskId: 'review' }
    const events = checklistHistoryEvents(timelineNoteChecklist(markdown), source, note)
    const review = events.filter(event => event.title === 'Review')
    expect(review).toHaveLength(1)
    expect(review[0].details).toEqual({
      markdown: ['Checked the contact sheet.', '![[sheet.png]]', '- [[Summary|See the summary]]', '  - A nested note', 'Parent conclusion.'].join('\n'),
      sourcePath: note.path,
      sourceLines: [4, 5, 6, 7, 10]
    })
    expect(events.find(event => event.title === 'Child')?.details?.markdown).toBe('Child-only notes')
    expect(events.find(event => event.title === 'Sibling')?.details).toBeUndefined()
  })

  it('retains quoted continuation content and handles a tab after an ordered marker', () => {
    const entries = timelineChecklist([
      '> 1. [x] Review 完成 @ 2026-11-24',
      '> \tDetail in the quote.',
      '> 2. [x] Next 完成 @ 2026-11-24',
      '>    Other note.',
      'Unrelated paragraph.'
    ].join('\n'))
    expect(entries.map(entry => entry.details?.trim())).toEqual(['Detail in the quote.', 'Other note.'])
  })

  it('keeps the saved start as context for an automatically completed checkbox', () => {
    const start = new Date(2026, 10, 22, 16, 20).getTime()
    const note = { path: 'Review.md', taskId: 'review' }
    const entries = timelineNoteChecklist(
      `- [x] Review %%dotpm-clock:0,1000,${start},auto-done%% 完成 @ 2026-11-24 20:18\n  Sample detail.`
    )
    const events = checklistHistoryEvents(entries, source, note)
    expect(events).toMatchObject([{
      day: '2026-11-24', kind: 'completion', firstStart: { day: '2026-11-22', time: '16:20' },
      details: { markdown: 'Sample detail.', sourcePath: note.path }
    }])
  })

  it('merges the saved start into an end recorded in the same minute', () => {
    const start = new Date(2026, 10, 24, 20, 18, 31).getTime()
    const records = checklistHistoryEvents(timelineChecklist([
      `- [x] Exposure %%dotpm-clock:0,1175,${start}%% 取消 @ 2026-11-24 20:18`,
      `- [x] Index %%dotpm-clock:${start + 496},496,${start}%% 完成 @ 2026-11-24 20:18`
    ].join('\n')), source)
    expect(records).toHaveLength(2)
    expect(records).toMatchObject([
      { title: 'Exposure', kind: 'cancellation', firstStart: { day: '2026-11-24', time: '20:18' } },
      { title: 'Index', kind: 'completion', firstStart: { day: '2026-11-24', time: '20:18' } }
    ])
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
    expect([...ascending.keys()]).toEqual(['2026-11-19', '2026-11-20'])
    expect([...descending.keys()]).toEqual(['2026-11-20', '2026-11-19'])
    expect(ascending.get('2026-11-20')?.map(entry => entry.time)).toEqual(['10:15', '11:00', undefined])
    expect(descending.get('2026-11-20')?.map(entry => entry.time)).toEqual(['11:00', '10:15', undefined])
  })
})
