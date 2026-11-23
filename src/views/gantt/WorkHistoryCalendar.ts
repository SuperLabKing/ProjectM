import { setIcon } from 'obsidian'
import { locale, t, Temporal, today } from '@dotpm/core'
import { Popover } from '@dotpm/ui'

export function openWorkHistoryCalendar(
  anchor: HTMLElement,
  selected: Temporal.PlainDate,
  recordedDays: ReadonlySet<string>,
  onPick: (day: Temporal.PlainDate) => void,
  onClose: () => void
): Popover {
  const pop = new Popover({ anchor, width: 264, onClose })
  const panel = pop.contentEl.createDiv({ cls: 'pm-wh-calendar', attr: { role: 'dialog', 'aria-label': t('workHistory.pickDate') } })
  const header = panel.createDiv('pm-wh-calendar-header')
  const previous = header.createEl('button', {
    attr: { type: 'button', 'aria-label': t('workHistory.previousMonth') }
  })
  setIcon(previous, 'chevron-left')
  const heading = header.createSpan({ attr: { 'aria-live': 'polite' } })
  const next = header.createEl('button', {
    attr: { type: 'button', 'aria-label': t('workHistory.nextMonth') }
  })
  setIcon(next, 'chevron-right')
  const grid = panel.createDiv('pm-wh-calendar-grid')
  const current = today()
  let month = selected.with({ day: 1 })

  const draw = (focused = selected.year === month.year && selected.month === month.month ? selected : month): void => {
    heading.setText(month.toLocaleString(locale(), { year: 'numeric', month: 'long' }))
    grid.empty()
    const first = month.subtract({ days: month.dayOfWeek - 1 })
    for (let offset = 0; offset < 7; offset++) {
      const label = first.add({ days: offset }).toLocaleString(locale(), { weekday: 'short' })
      grid.createSpan({ cls: 'pm-wh-calendar-weekday', text: label })
    }
    for (let offset = 0; offset < 42; offset++) {
      const day = first.add({ days: offset })
      const id = day.toString()
      const label = day.toLocaleString(locale(), { dateStyle: 'full' })
      const recorded = recordedDays.has(id)
      const button = grid.createEl('button', {
        cls: 'pm-wh-calendar-day',
        text: String(day.day),
        attr: {
          type: 'button',
          'aria-label': recorded ? t('workHistory.recordedDay', { date: label }) : label,
          'aria-pressed': String(day.equals(selected)),
          tabindex: day.equals(focused) ? '0' : '-1',
          'data-wh-date': id
        }
      })
      if (recorded) button.dataset.whHasRecords = ''
      if (day.month !== month.month) button.addClass('pm-wh-calendar-other-month')
      if (day.equals(current)) button.setAttribute('aria-current', 'date')
      button.onclick = () => {
        pop.close()
        onPick(day)
      }
    }
  }
  previous.onclick = () => {
    month = month.subtract({ months: 1 })
    draw()
  }
  next.onclick = () => {
    month = month.add({ months: 1 })
    draw()
  }
  const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
  grid.addEventListener('keydown', (event) => {
    const active = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-wh-date]')
    const offset = offsets[event.key]
    if (!active?.dataset.whDate || !offset) return
    event.preventDefault()
    const direction = grid.matches(':dir(rtl)') && Math.abs(offset) === 1 ? -1 : 1
    const day = Temporal.PlainDate.from(active.dataset.whDate).add({ days: offset * direction })
    if (day.month !== month.month || day.year !== month.year) {
      month = day.with({ day: 1 })
      draw(day)
    }
    active.tabIndex = -1
    const nextDay = grid.querySelector<HTMLButtonElement>(`[data-wh-date="${day.toString()}"]`)
    if (nextDay) {
      nextDay.tabIndex = 0
      nextDay.focus({ preventScroll: true })
    }
  })
  draw()
  pop.open()
  grid.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus({ preventScroll: true })
  return pop
}
