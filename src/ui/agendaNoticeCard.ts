import { setIcon } from 'obsidian'
import { t } from '@dotpm/core'

export function createAgendaNoticeCard(
  doc: Document,
  options: { message: string; snoozeLabel?: string; preview?: boolean }
) {
  const { message, snoozeLabel, preview } = options
  const card = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div')
  card.className = 'pm-agenda-notice'
  if (preview) card.dataset.preview = 'true'
  const header = card.createDiv('pm-agenda-notice-header')
  const category = header.createSpan('pm-agenda-notice-category')
  setIcon(category.createSpan(), 'bell')
  category.createSpan({ text: t(preview ? 'agenda.previewTitle' : 'agenda.title') })
  const content = card.createDiv({ attr: { role: 'status' } })
  const footer = card.createDiv('pm-agenda-notice-footer')
  const open = preview
    ? undefined
    : content.createEl('button', {
        cls: 'pm-agenda-notice-action',
        text: message,
        attr: { type: 'button', title: t('agenda.openReminder') }
      })
  if (preview) content.createSpan({ cls: 'pm-agenda-notice-action', text: message })
  const snooze = preview
    ? undefined
    : footer.createEl('button', { cls: 'pm-agenda-notice-snooze', text: snoozeLabel, attr: { type: 'button' } })
  if (!snooze && snoozeLabel) footer.createSpan({ cls: 'pm-agenda-notice-snooze', text: snoozeLabel })
  const confirm = footer.createEl('button', {
    cls: 'pm-agenda-notice-confirm',
    text: t('agenda.confirmReminder'),
    attr: { type: 'button' }
  })
  return { card, header, open, snooze, confirm }
}
