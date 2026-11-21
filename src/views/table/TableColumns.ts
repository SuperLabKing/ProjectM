import { t } from '@dotpm/core'

export const FILL_TITLE_WIDTH = 180
const MIN_COLUMN_WIDTH = 48
const MIN_TITLE_WIDTH = 96

/** The title fills spare space at default widths. Resizing another column changes
 * the table's width by the same amount, so the title cannot absorb the drag. */
export function createTableColumns(
  table: HTMLTableElement,
  leading: number[],
  columns: { id: string; defaultWidth: number; width?: number }[],
  trailing: number
): (id: string, width: number | undefined) => void {
  const colgroup = table.createEl('colgroup')
  const addFixedColumn = (width: number) => colgroup.createEl('col').style.setProperty('width', width + 'px')
  leading.forEach(addFixedColumn)
  const fields = columns.map((column) => ({ ...column, el: colgroup.createEl('col') }))
  addFixedColumn(trailing)
  const structuralWidth = leading.reduce((sum, width) => sum + width, trailing)
  const update = () => {
    let total = structuralWidth
    let delta = 0
    let fillTitle = false
    for (const { id, defaultWidth, width, el } of fields) {
      const hasWidth = typeof width === 'number' && Number.isFinite(width)
      const auto = id === 'title' && !hasWidth
      const effective = hasWidth ? Math.max(minWidth(id), width) : defaultWidth
      el.style.width = auto ? '' : effective + 'px'
      total += effective
      if (auto) fillTitle = true
      else delta += effective - defaultWidth
    }
    const fluidWidth = delta < 0 ? '100% - ' + -delta + 'px' : '100% + ' + delta + 'px'
    table.style.width = fillTitle ? 'max(' + total + 'px, calc(' + fluidWidth + '))' : total + 'px'
  }
  update()
  return (id, width) => {
    const column = fields.find((field) => field.id === id)
    if (!column) return
    column.width = width
    update()
  }
}

function minWidth(id: string): number {
  return id === 'title' ? MIN_TITLE_WIDTH : MIN_COLUMN_WIDTH
}

export function attachColumnResize(
  th: HTMLTableCellElement,
  table: HTMLTableElement,
  id: string,
  preview: (width?: number) => void,
  save: (width: number) => void,
  appendUnrendered?: (body: HTMLTableSectionElement) => void
): void {
  th.addClass('pm-table-th-resizable')
  const label = t('table.fitProjectColumn')
  const handle = th.createDiv({
    cls: 'pm-table-resize',
    attr: { tabindex: '0', role: 'button', 'aria-label': label, title: label }
  })
  const view = th.ownerDocument.defaultView
  const wrapper = table.parentElement
  if (!view || !wrapper) return
  const currentWidth = () => Math.round(th.getBoundingClientRect().width)
  const bounded = (width: number) => Math.max(minWidth(id), Math.round(width))
  const commit = (width: number) => {
    preview(width)
    save(width)
  }
  const fit = () => commit(bounded(fitColumn(table, th, appendUnrendered)))
  handle.addEventListener('click', (event) => event.stopPropagation())
  handle.addEventListener('dblclick', (event) => {
    event.stopPropagation()
    fit()
  })
  handle.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      fit()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      event.stopPropagation()
      const step = event.shiftKey ? 24 : 8
      const direction = event.key === 'ArrowRight' ? 1 : -1
      const width = bounded(currentWidth() + step * direction)
      if (width !== currentWidth()) commit(width)
    }
  })
  handle.addEventListener('pointerdown', (down) => {
    if (down.button !== 0 || !down.isPrimary) return
    down.preventDefault()
    down.stopPropagation()
    if (wrapper.hasClass('is-column-resizing')) return
    const startWidth = currentWidth()
    const startScroll = wrapper.scrollLeft
    let width = startWidth
    let painted = startWidth
    let frame = 0
    const controller = new AbortController()
    const { signal } = controller
    const paint = () => {
      frame = 0
      if (width === painted) return
      if (width === startWidth) preview()
      else preview(width)
      painted = width
    }
    const move = (event: PointerEvent) => {
      if (event.pointerId !== down.pointerId) return
      const delta = event.clientX - down.clientX
      // Leave enough tolerance for a normal click or double-click on the divider.
      width = Math.abs(delta) < 3 ? startWidth : bounded(startWidth + delta)
      if (!frame && width !== painted) frame = view.requestAnimationFrame(paint)
    }
    const finish = (accept: boolean) => {
      controller.abort()
      view.cancelAnimationFrame(frame)
      th.removeClass('is-resizing')
      wrapper.removeClass('is-column-resizing')
      if (handle.hasPointerCapture(down.pointerId)) handle.releasePointerCapture(down.pointerId)
      if (accept && th.isConnected && width !== startWidth) commit(width)
      else {
        if (painted !== startWidth) preview()
        wrapper.scrollLeft = startScroll
      }
    }
    handle.setPointerCapture(down.pointerId)
    th.addClass('is-resizing')
    wrapper.addClass('is-column-resizing')
    handle.addEventListener('pointermove', move, { signal })
    handle.addEventListener(
      'pointerup',
      (event) => {
        if (event.pointerId !== down.pointerId) return
        move(event)
        finish(true)
      },
      { signal }
    )
    for (const type of ['pointercancel', 'lostpointercapture'] as const) {
      handle.addEventListener(
        type,
        (event) => {
          if (event.pointerId === down.pointerId) finish(false)
        },
        { signal }
      )
    }
    view.addEventListener('blur', () => finish(false), { signal })
    th.ownerDocument.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        finish(false)
      },
      { capture: true, signal }
    )
  })
}

/** Measure the target column in a hidden, intrinsically sized table. */
function fitColumn(
  table: HTMLTableElement,
  th: HTMLTableCellElement,
  appendUnrendered?: (body: HTMLTableSectionElement) => void
): number {
  const measure = table.ownerDocument.createElement('table')
  measure.className = table.className + ' pm-table-column-measure'
  measure.setAttribute('aria-hidden', 'true')
  measure.inert = true
  const heading = th.cloneNode(true) as HTMLTableCellElement
  heading.querySelector('.pm-table-resize')?.remove()
  measure.createTHead().insertRow().append(heading)
  const body = measure.createTBody()
  for (const row of table.tBodies[0]?.rows ?? []) {
    if (!row.matches('.pm-table-row')) continue
    const cell = row.cells[th.cellIndex]
    if (!cell) continue
    const copy = row.cloneNode(false) as HTMLTableRowElement
    copy.append(cell.cloneNode(true))
    body.append(copy)
  }
  appendUnrendered?.(body)
  table.after(measure)
  const width = Math.ceil(heading.getBoundingClientRect().width) + 8
  measure.remove()
  return width
}
