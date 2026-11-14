type RowSnapshot = { row: HTMLTableRowElement; bounds: DOMRect; opacity: number }

const TIMING = { duration: 230, easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)' }
const ROWS = 'tr[data-pm-fold-row]'
const TOGGLE = '.pm-collapse-toggle svg, .pm-task-group-toggle svg, .pm-linked-fold-toggle svg'
const running = new WeakMap<HTMLElement, Animation[]>()
const updating = new WeakSet<HTMLElement>()

function visibleRows(wrapper: HTMLElement, tbody: HTMLElement): Map<string, RowSnapshot> {
  const viewport = wrapper.getBoundingClientRect()
  const result = new Map<string, RowSnapshot>()
  for (const row of tbody.querySelectorAll<HTMLTableRowElement>(ROWS)) {
    const bounds = row.getBoundingClientRect()
    if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
      const opacity = Number(row.ownerDocument.defaultView?.getComputedStyle(row).opacity ?? 1)
      result.set(row.dataset.pmFoldRow ?? '', { row, bounds, opacity })
    }
  }
  return result
}

export async function animateTableFold(
  wrapper: HTMLElement | null,
  tbody: HTMLElement | null,
  key: string,
  collapsed: boolean,
  update: () => void | Promise<void>
): Promise<void> {
  if (tbody && updating.has(tbody)) return
  const refresh = async () => {
    if (tbody) updating.add(tbody)
    try {
      await update()
    } finally {
      if (tbody) updating.delete(tbody)
    }
  }
  const win = wrapper?.ownerDocument.defaultView
  if (!win || !wrapper || !tbody || win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await refresh()
    return
  }
  const before = visibleRows(wrapper, tbody)
  const anchorBefore = before.get(key)
  if (!anchorBefore) {
    await refresh()
    return
  }

  // Capture the visible cells before refresh replaces the table rows.
  const copies = new Map<string, HTMLTableElement>()
  if (collapsed) {
    const depth = Number(anchorBefore.row.style.getPropertyValue('--depth')) || 0
    const isGroup = anchorBefore.row.matches('.pm-task-group-row')
    for (
      let row = anchorBefore.row.nextElementSibling;
      row instanceof HTMLTableRowElement;
      row = row.nextElementSibling
    ) {
      const id = row.dataset.pmFoldRow
      if (!id || row.matches('.pm-task-group-row')) break
      if (!isGroup && (Number(row.style.getPropertyValue('--depth')) || 0) <= depth) break
      const previous = before.get(id)
      if (!previous) continue
      const { bounds } = previous
      const table = wrapper.ownerDocument.createElement('table')
      table.className = 'pm-table pm-fold-copy'
      table.setCssStyles({ left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px` })
      const columns = table.createEl('colgroup')
      for (const cell of row.cells) {
        columns.createEl('col').setCssStyles({ width: `${cell.getBoundingClientRect().width}px` })
      }
      table.createTBody().append(row.cloneNode(true))
      copies.set(id, table)
    }
  }

  await refresh()
  if (!tbody.isConnected) return
  const after = visibleRows(wrapper, tbody)
  const anchor = after.get(key)
  if (!anchor) return
  for (const animation of running.get(tbody) ?? []) animation.cancel()

  const animations: Animation[] = []
  running.set(tbody, animations)
  const toggle = anchor.row.querySelector(TOGGLE)
  // The newly rendered icon is already in its final state.
  if (toggle) {
    animations.push(toggle.animate([{ rotate: collapsed ? '90deg' : '-90deg' }, { rotate: '0deg' }], TIMING))
  }

  for (const [id, { row, bounds, opacity }] of after) {
    const previous = before.get(id)
    if (previous) {
      const delta = previous.bounds.top - bounds.top
      if (Math.abs(delta) > 0.5) {
        animations.push(row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], TIMING))
      }
    } else if (!collapsed && bounds.top >= anchor.bounds.bottom - 1) {
      animations.push(
        row.animate(
          [
            { opacity: 0, transform: 'translateY(-6px)' },
            { opacity, transform: 'none' }
          ],
          TIMING
        )
      )
    }
  }

  const viewport = wrapper.getBoundingClientRect()
  const headerBottom = tbody.previousElementSibling?.getBoundingClientRect().bottom ?? viewport.top
  const layer = wrapper.ownerDocument.body.createDiv({
    cls: 'pm-fold-layer',
    attr: { 'aria-hidden': 'true', inert: '' }
  })
  layer.setCssStyles({
    clipPath: `inset(${Math.max(0, viewport.top, headerBottom)}px ${Math.max(0, win.innerWidth - viewport.right)}px ${Math.max(0, win.innerHeight - viewport.bottom)}px ${Math.max(0, viewport.left)}px)`
  })
  for (const [id, copy] of copies) {
    const previous = before.get(id)
    if (!previous || after.has(id) || previous.bounds.top < anchorBefore.bounds.bottom - 1) continue
    layer.append(copy)
    animations.push(
      copy.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-6px)' }], {
        ...TIMING,
        duration: 145,
        fill: 'forwards'
      })
    )
  }

  await Promise.allSettled(animations.map((animation) => animation.finished))
  layer.remove()
  if (running.get(tbody) === animations) running.delete(tbody)
}
