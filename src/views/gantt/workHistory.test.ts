import { describe, expect, it } from 'vitest'
import { timelineChecklist } from './timelineDates'
import { historyDays, historyEvents } from './workHistory'

describe('work history', () => {
  const records = historyEvents({
    sourceKey: 'delivery|review',
    project: 'Delivery',
    title: 'Review',
    start: '2026-11-17',
    due: '2026-11-19',
    completed: '2026-11-20',
    cancelled: false,
    checklist: timelineChecklist(
      [
        '- [x] Draft 计划 @ 2026-11-17 08:00~2026-11-19 16:00 开始 @ 2026-11-18 09:00 完成 @ 2026-11-20 10:15',
        '- [x] Verify 开始 @ 2026-11-19 12:00 完成 @ 2026-11-19 12:40',
        '- [x] Obsolete 取消 @ 2026-11-20 11:00',
        '- [ ] Future 截止 @ 2026-11-22'
      ].join('\n')
    )
  })

  it('groups by recorded dates, folds same-day completion and never fills intervening days', () => {
    const days = historyDays(records, '2026-11-14', '2026-11-29', false)
    expect([...days.keys()]).toEqual(['2026-11-20', '2026-11-19', '2026-11-18'])
    expect(days.get('2026-11-20')).toMatchObject([
      { title: 'Review', kind: 'completion', children: [{ title: 'Draft', time: '10:15' }] },
      { title: 'Obsolete', kind: 'cancellation' }
    ])
    expect(days.get('2026-11-19')).toMatchObject([{ title: 'Verify', time: '12:00', endTime: '12:40' }])
    expect(days.get('2026-11-18')).toMatchObject([{ title: 'Draft', kind: 'start' }])
  })

  it('adds planned dates only when requested and clips the selected period', () => {
    const days = historyDays(records, '2026-11-17', '2026-11-22', true)
    expect([...days.keys()]).toEqual(['2026-11-20', '2026-11-19', '2026-11-18', '2026-11-17'])
    expect(days.get('2026-11-17')).toMatchObject([
      { title: 'Review', kind: 'planStart', planned: true },
      { title: 'Draft', kind: 'planStart', planned: true }
    ])
    expect(days.get('2026-11-19')?.filter((event) => event.kind === 'planEnd')).toHaveLength(2)
  })
})
