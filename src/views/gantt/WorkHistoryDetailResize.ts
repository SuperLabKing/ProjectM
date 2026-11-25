import type { App } from 'obsidian'
import { t } from '@dotpm/core'

const WIDTH_KEY = 'projectmaster-work-history-detail-width'
const MIN_RATIO = 0.25
const MAX_RATIO = 0.58

export function attachWorkHistoryDetailResize(layout: HTMLElement, pane: HTMLElement, app: App): void {
  const separator = layout.createDiv({
    cls: 'pm-wh-detail-resize',
    attr: { role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': t('workHistory.resizeDetails') }
  })
  pane.before(separator)
  const limitRatio = (ratio: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
  const apply = (ratio: number) => {
    const width = limitRatio(ratio)
    layout.style.setProperty('--pm-wh-detail-width', `${width * 100}%`)
    separator.setAttribute('aria-valuenow', String(Math.round(width * 100)))
    return width
  }
  separator.setAttribute('aria-valuemin', String(MIN_RATIO * 100))
  separator.setAttribute('aria-valuemax', String(MAX_RATIO * 100))
  separator.setAttribute('aria-valuenow', '35')
  const stored: unknown = app.loadLocalStorage(WIDTH_KEY)
  if (typeof stored === 'number' && Number.isFinite(stored)) apply(stored)

  const direction = () => layout.matches(':dir(rtl)') ? -1 : 1
  let drag: { id: number; x: number; width: number; previous: string; previousValue: string } | undefined
  separator.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag || !layout.clientWidth) return
    separator.setPointerCapture(event.pointerId)
    drag = {
      id: event.pointerId,
      x: event.clientX,
      width: pane.offsetWidth,
      previous: layout.style.getPropertyValue('--pm-wh-detail-width'),
      previousValue: separator.getAttribute('aria-valuenow') ?? '35'
    }
    event.preventDefault()
  })
  separator.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId || !layout.clientWidth) return
    apply((drag.width + (drag.x - event.clientX) * direction()) / layout.clientWidth)
  })
  separator.addEventListener('pointerup', (event) => {
    if (drag?.id !== event.pointerId) return
    const start = drag
    drag = undefined
    if (event.clientX === start.x || !layout.clientWidth) {
      layout.style.setProperty('--pm-wh-detail-width', start.previous)
      separator.setAttribute('aria-valuenow', start.previousValue)
      return
    }
    const width = apply((start.width + (start.x - event.clientX) * direction()) / layout.clientWidth)
    app.saveLocalStorage(WIDTH_KEY, width)
  })
  separator.addEventListener('lostpointercapture', () => {
    if (!drag) return
    layout.style.setProperty('--pm-wh-detail-width', drag.previous)
    separator.setAttribute('aria-valuenow', drag.previousValue)
    drag = undefined
  })
  separator.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' || !layout.clientWidth) return
    event.preventDefault()
    event.stopPropagation()
    const step = (event.key === 'ArrowLeft' ? 20 : -20) * direction()
    app.saveLocalStorage(WIDTH_KEY, apply((pane.offsetWidth + step) / layout.clientWidth))
  })
}
