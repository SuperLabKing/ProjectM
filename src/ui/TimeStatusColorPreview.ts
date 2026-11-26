import { t, type PMSettings, type TimeStatus } from '@dotpm/core'
import { setIcon } from 'obsidian'
import { workHistoryKinds } from '../views/gantt/workHistory'
import { writeTimeStatusColor } from './timeStatusPalette'

type Palette = PMSettings['timeStatusColors']

const dateKinds: Record<TimeStatus, string> = {
  plan: 'plan',
  start: 'start',
  completion: 'done',
  hold: 'hold',
  cancellation: 'cancel'
}

export function renderTimeStatusColorPreview(parent: HTMLElement, palette: Palette) {
  const preview = parent.createDiv('pm-time-color-preview')

  const renderCard = (title: string) => {
    const card = preview.createDiv('pm-time-color-preview-card')
    const heading = card.createDiv({ cls: 'pm-time-color-preview-heading', text: title })
    return { heading, sample: card.createDiv('pm-time-color-preview-sample') }
  }

  const review = renderCard(t('views.timeline'))
  const log = review.sample.createDiv('pm-wh-log pm-time-color-preview-log')
  const row = log.createEl('ul', { cls: 'pm-wh-items' }).createEl('li', { cls: 'pm-wh-entry' })
  row.createDiv('pm-wh-time').createSpan({ cls: 'pm-wh-time-value', text: '09:30' })
  const body = row.createDiv('pm-wh-event-body')
  const badge = body.createSpan({ cls: 'pm-wh-kind', attr: { 'aria-hidden': 'true' } })
  const content = body.createDiv()
  content.createDiv({ cls: 'pm-wh-title', text: t('settings.timeStatusColors.previewSample') })
  const source = content.createDiv('pm-wh-source')
  const sourcePart = source.createSpan('pm-wh-source-part')
  setIcon(sourcePart.createSpan({ cls: 'pm-wh-source-icon', attr: { 'aria-hidden': 'true' } }), 'clipboard-list')
  sourcePart.createSpan({ cls: 'pm-wh-source-name', text: t('settings.timeStatusColors.previewSource') })

  const agenda = review.sample.createDiv('pm-time-color-preview-agenda')
  agenda.createSpan({ cls: 'pm-agenda-status-dot', attr: { 'data-status-tone': 'todo', 'aria-hidden': 'true' } })
  agenda.createSpan({ text: t('settings.timeStatusColors.previewSample') })
  agenda.createSpan({ cls: 'pm-time-color-preview-agenda-time', text: '09:30' })

  const capsule = renderCard(t('settings.timeStatusColors.previewCapsule')).sample.createSpan()

  const picker = renderCard(t('settings.timeStatusColors.previewPicker'))
  const selected = picker.sample.createSpan('pm-time-color-preview-selected')
  selected.createSpan({ cls: 'dotpm-dm-kind-dot', attr: { 'aria-hidden': 'true' } })
  const label = selected.createSpan()
  picker.sample.createSpan({ cls: 'pm-time-color-preview-confirm', text: t('settings.timeStatusColors.previewConfirm') })

  function show(status: TimeStatus, colors: Palette) {
    writeTimeStatusColor(preview.style, colors, status)
    if (preview.dataset.previewStatus === status) return

    preview.dataset.previewStatus = status
    const key = '--pm-time-' + status
    preview.style.setProperty('--pm-review-status', `var(${key})`)
    preview.style.setProperty('--pm-review-status-ink', `var(${key}-ink)`)
    preview.style.setProperty('--pm-review-status-text', `var(${key}-text)`)
    review.heading.textContent = t(status === 'plan' ? 'agenda.title' : 'views.timeline')
    log.hidden = status === 'plan'
    agenda.hidden = status !== 'plan'
    row.dataset.historyKind = status
    if (status !== 'plan') setIcon(badge, workHistoryKinds[status].icon)
    const kind = dateKinds[status]
    const name = t(status === 'plan' ? 'projectTimeline.plan' : status === 'start' ? 'columns.start' : workHistoryKinds[status].label)
    capsule.className = `pm-time pm-time--markdown pm-time--${kind} dotpm-time-compact`
    capsule.textContent = `${name} 11/25`
    picker.sample.className = `pm-time-color-preview-sample pm-time-color-preview-picker pm-time--${kind}`
    label.textContent = name
  }

  show('completion', palette)
  return show
}
