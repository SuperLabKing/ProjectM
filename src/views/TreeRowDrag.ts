import { t } from '@dotpm/core'
import { safeAsync } from '@dotpm/ui'

export type TreeDrop = 'before' | 'inside' | 'after'
interface RowDragOptions {
  targetOnly?: boolean
  section?: boolean
  dropPosition?: (source: string, position: TreeDrop, offset: number) => TreeDrop
}
interface DropAction {
  parent: string | null
  changesParent: boolean
  parentTitle?: string
  label?: string
}
const HOLD_MS = 170
const MOUSE_DRAG_INTENT_MS = 90
const PRESS_SLOP = 8
const ROW_SELECTOR = 'tr[data-pm-drag-id]'
const MOTION = { duration: 180, easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)' }
const LANDING = { duration: 280, easing: 'cubic-bezier(0.18, 0.72, 0.25, 1)' }
type RowPositions = Map<string, number>
interface DropTarget {
  preview: (y: number) => TreeDrop | null
  hover: (position: TreeDrop) => void
  drop: (position: TreeDrop) => Promise<void>
}

/** Keep the source row visible at mouseup while saving replaces the real rows. */
function holdMovingRows(host: HTMLElement, moving: HTMLElement[]) {
  const doc = host.ownerDocument
  const viewport = host.querySelector('.pm-table-wrapper')?.getBoundingClientRect()
  if (!viewport || doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const layer = doc.body.createDiv({ cls: 'pm-tree-landing-layer', attr: { 'aria-hidden': 'true', inert: '' } })
  layer.setCssStyles({
    left: `${viewport.left}px`,
    top: `${viewport.top}px`,
    width: `${viewport.width}px`,
    height: `${viewport.height}px`
  })
  const ids = new Set(moving.map((row) => row.dataset.pmDragId))
  const copies = moving.flatMap((row) => {
    const bounds = row.getBoundingClientRect()
    if (!row.isConnected || bounds.bottom < viewport.top || bounds.top > viewport.bottom) return []
    const original = row.closest('table')
    const copy = layer.createEl('table', { cls: `${original?.className ?? 'pm-table'} pm-tree-landing-copy` })
    copy.setCssStyles({
      left: `${bounds.left - viewport.left}px`,
      top: `${bounds.top - viewport.top}px`,
      width: `${bounds.width}px`
    })
    const columns = copy.createEl('colgroup')
    for (const cell of (row as HTMLTableRowElement).cells) {
      columns.createEl('col').setCssStyles({ width: `${cell.getBoundingClientRect().width}px` })
    }
    const body = copy.createTBody()
    const visual = body.appendChild(row.cloneNode(true) as HTMLElement)
    visual.removeClass('pm-tree-dragging')
    visual.removeAttribute('data-pm-drag-id')
    return [{ id: row.dataset.pmDragId, copy, top: bounds.top, left: bounds.left, visual }]
  })
  const hidden = new Set<HTMLElement>()
  const hide = () => {
    for (const row of host.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      if (!ids.has(row.dataset.pmDragId) || hidden.has(row)) continue
      hidden.add(row)
      row.addClass('pm-tree-landing-hidden')
    }
  }
  hide()
  const observer = new MutationObserver(hide)
  observer.observe(host, { childList: true, subtree: true })
  const cleanup = () => {
    observer.disconnect()
    for (const row of hidden) row.removeClass('pm-tree-landing-hidden')
    layer.remove()
  }
  return {
    cleanup,
    async land(): Promise<void> {
      const targets = new Map(
        [...host.querySelectorAll<HTMLElement>(ROW_SELECTOR)].map((row) => [row.dataset.pmDragId, row])
      )
      const animations = copies.flatMap(({ id, copy, top, left, visual }) => {
        const target = targets.get(id)
        if (!target) return [copy.animate([{ opacity: 1 }, { opacity: 0 }], LANDING).finished]
        const bounds = target.getBoundingClientRect()
        const titleOffset = (depthOf(target) - depthOf(visual)) * 20
        const title = visual.querySelector('.pm-table-title-inner')
        if (titleOffset) {
          title?.animate([{ transform: 'none' }, { transform: `translateX(${titleOffset}px)` }], {
            ...LANDING,
            fill: 'forwards'
          })
        }
        return [
          copy.animate(
            [{ transform: 'none' }, { transform: `translate(${bounds.left - left}px, ${bounds.top - top}px)` }],
            { ...LANDING, fill: 'forwards' }
          ).finished
        ]
      })
      await Promise.allSettled(animations)
    }
  }
}

function visibleRows(host: HTMLElement): HTMLElement[] {
  const rows = host.querySelectorAll<HTMLElement>(ROW_SELECTOR)
  const viewport = host.closest('.pm-table-wrapper') ?? host.querySelector('.pm-table-wrapper')
  if (!viewport) return [...rows]
  const { top, bottom } = viewport.getBoundingClientRect()
  return [...rows].filter((row) => {
    const bounds = row.getBoundingClientRect()
    return bounds.bottom >= top - 110 && bounds.top <= bottom + 110
  })
}

function rowPositions(host: HTMLElement): RowPositions {
  return new Map(visibleRows(host).map((row) => [row.dataset.pmDragId ?? '', row.getBoundingClientRect().top]))
}

function depthOf(row: HTMLElement): number {
  if (row.dataset.pmDragSection === 'true') return -1
  return Number(row.style.getPropertyValue('--depth')) || 0
}

function dropIndent(row: HTMLElement): number {
  const title = row.querySelector<HTMLElement>('.pm-table-cell-title')
  return (title?.offsetLeft ?? 0) + Math.max(0, depthOf(row)) * 20 + 8
}

export class TreeRowDrag {
  private source: string | null = null
  private moving: string[] = []
  private dimmed: HTMLElement[] = []
  private highlighted: HTMLElement | null = null
  private gap: HTMLTableRowElement | null = null
  private gapPosition: TreeDrop | null = null
  private saving = false
  private rowAnimations = new Map<HTMLElement, Animation>()
  private pendingHover: { win: Window; frame: number; apply: () => void } | null = null
  private gapHeight = 0
  private gapTarget: DropTarget | null = null
  private targets = new WeakMap<Element, DropTarget>()
  private pressing = false
  private hint: HTMLElement | null = null

  constructor(
    private getDrop: (sources: string[], target: string, position: TreeDrop) => DropAction | null,
    private move: (sources: string[], target: string, position: TreeDrop) => Promise<void>,
    private selection: (id: string) => string[] = (id) => [id],
    private projects = false
  ) {}

  isPreviewing(): boolean {
    return !!this.gap?.isConnected
  }

  attach(row: HTMLTableRowElement, id: string, options: RowDragOptions = {}): void {
    row.dataset.pmDragId = id
    if (options.section) row.dataset.pmDragSection = 'true'
    const start = () => {
      this.source = id
      this.moving = this.selection(id)
      const table = row.closest('table')
      const moving = new Set(this.moving)
      let movingDepth = Infinity
      this.dimmed = [...(table?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? [])].filter((item) => {
        const depth = depthOf(item)
        if (depth <= movingDepth) movingDepth = moving.has(item.dataset.pmDragId ?? '') ? depth : Infinity
        return movingDepth !== Infinity
      })
      for (const item of this.dimmed) item.addClass('pm-tree-dragging')
      this.gapHeight = Math.min(48, 28 + Math.max(0, this.dimmed.length - 1) * 4)
    }

    let cachedSelection: string[] | null = null
    const valid = new Map<TreeDrop, DropAction | null>()
    const destination = (y: number): TreeDrop | null => {
      if (this.saving || !this.source || this.moving.includes(id)) return null
      const bounds = row.getBoundingClientRect()
      const offset = (y - bounds.top) / bounds.height
      const previous = this.highlighted === row ? this.gapPosition : null
      const upper = previous === 'before' ? 0.32 : previous === 'inside' ? 0.22 : 0.27
      const lower = previous === 'after' ? 0.68 : previous === 'inside' ? 0.78 : 0.73
      const naturalPosition = offset < upper ? 'before' : offset > lower ? 'after' : 'inside'
      const position = options.dropPosition?.(this.source, naturalPosition, offset) ?? naturalPosition
      if (cachedSelection !== this.moving) {
        cachedSelection = this.moving
        valid.clear()
      }
      if (!valid.has(position)) valid.set(position, this.getDrop(this.moving, id, position))
      return valid.get(position) ? position : null
    }
    const applyHover = (position: TreeDrop): void => {
      if (!row.isConnected || this.saving || !this.source) return
      if (
        this.highlighted === row &&
        this.gapPosition === position &&
        (position === 'inside' || this.gap?.isConnected)
      ) {
        return
      }
      const table = row.closest('table')
      if (!table) return
      const before = rowPositions(table)
      this.highlighted?.removeAttribute('data-pm-tree-drop')
      row.dataset.pmTreeDrop = position
      this.highlighted = row
      this.gapPosition = position
      if (position === 'inside') {
        this.removeGap()
      } else {
        this.openGap(row, position)
        this.gapTarget = { preview: () => position, hover, drop }
      }
      this.animateRows(table, before)
      const action = valid.get(position)
      if (action) this.showHint(row, action)
    }
    const hover = (position: TreeDrop): void => {
      const win = row.ownerDocument.defaultView
      const apply = () => applyHover(position)
      if (this.pendingHover) this.pendingHover.apply = apply
      else if (win) {
        const frame = win.requestAnimationFrame(() => {
          const pending = this.pendingHover
          this.pendingHover = null
          pending?.apply()
        })
        this.pendingHover = { win, frame, apply }
      } else apply()
    }
    const drop = async (position: TreeDrop): Promise<void> => {
      const moving = this.moving
      const table = row.closest('table')
      const host = table?.parentElement?.parentElement
      if (this.saving || !this.source || !table) return
      this.cancelHover()
      const before = rowPositions(table)
      const movingRows = new Set(this.dimmed.map((item) => item.dataset.pmDragId ?? ''))
      for (const item of this.dimmed) {
        if (item.isConnected) before.set(item.dataset.pmDragId ?? '', item.getBoundingClientRect().top)
      }
      this.saving = true
      const landing = host ? holdMovingRows(host, this.dimmed) : undefined
      try {
        await this.move(moving, id, position)
        this.clear(false)
        if (host?.isConnected) this.animateRows(host, before, movingRows, !!landing)
        await landing?.land()
      } finally {
        landing?.cleanup()
        this.clear()
        this.saving = false
      }
    }
    this.targets.set(row, { preview: destination, hover, drop })
    if (!options.targetOnly) row.addEventListener('pointerdown', (event) => this.beginPress(row, event, start))
  }

  private beginPress(row: HTMLElement, event: PointerEvent, start: () => void): void {
    const target = event.target as Element
    const control = target.closest('button, input, select, textarea, a, [role="button"], [contenteditable="true"]')
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      this.pressing ||
      this.saving ||
      (control && !control.matches('.projectm-linked-title'))
    ) {
      return
    }

    const doc = row.ownerDocument
    const win = doc.defaultView
    const table = row.closest('table')
    if (!win || !table) return
    this.pressing = true
    const listeners = new AbortController()
    const options = { capture: true, signal: listeners.signal }
    let active = false
    const activate = () => {
      if (!row.isConnected) {
        finish()
        return false
      }
      win.clearTimeout(timer)
      active = true
      start()
      table.addClass('pm-tree-press-active')
      doc.getSelection()?.removeAllRanges()
      return true
    }
    const timer = win.setTimeout(activate, event.pointerType === 'touch' ? 300 : HOLD_MS)

    const locate = (e: PointerEvent) => {
      const hit = doc.elementFromPoint(e.clientX, e.clientY)?.closest('tr')
      if (hit?.closest('table') !== table) return
      const target = hit === this.gap ? this.gapTarget : this.targets.get(hit)
      const position = target?.preview(e.clientY)
      return target && position ? { target, position } : undefined
    }
    const finish = (e?: PointerEvent, commit = false) => {
      win.clearTimeout(timer)
      listeners.abort()
      this.pressing = false
      table.removeClass('pm-tree-press-active')
      if (!active) return
      if (e) {
        e.preventDefault()
        const stopClick = (click: MouseEvent) => {
          click.preventDefault()
          click.stopImmediatePropagation()
        }
        doc.addEventListener('click', stopClick, { capture: true, once: true })
        win.setTimeout(() => doc.removeEventListener('click', stopClick, true), 0)
      }
      const destination = commit && e ? locate(e) : undefined
      if (destination) safeAsync(() => destination.target.drop(destination.position))()
      else this.clear()
    }
    doc.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== event.pointerId) return
        if (!active) {
          const distance = Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY)
          if (distance < PRESS_SLOP) return
          if (event.pointerType === 'touch') {
            finish()
            return
          }
          if (e.timeStamp - event.timeStamp < MOUSE_DRAG_INTENT_MS || !activate()) return
        }
        e.preventDefault()
        const destination = locate(e)
        if (destination) destination.target.hover(destination.position)
        else if (!this.dimmed.some((item) => item.contains(doc.elementFromPoint(e.clientX, e.clientY)))) {
          this.clearTarget()
        }
      },
      options
    )
    doc.addEventListener(
      'pointerup',
      (e) => {
        if (e.pointerId === event.pointerId) finish(e, true)
      },
      options
    )
    doc.addEventListener(
      'pointercancel',
      (e) => {
        if (e.pointerId === event.pointerId) finish()
      },
      options
    )
    doc.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') finish()
      },
      options
    )
    doc.addEventListener('dragstart', (e) => e.preventDefault(), options)
    row.addEventListener(
      'contextmenu',
      (e) => {
        if (active) {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
      },
      options
    )
    win.addEventListener('blur', () => finish(), options)
  }

  private openGap(row: HTMLTableRowElement, position: 'before' | 'after'): void {
    const gap = this.gap ?? row.ownerDocument.createElement('tr')
    gap.className = 'pm-tree-drop-gap'
    gap.setAttribute('aria-hidden', 'true')
    const cell = gap.cells[0] ?? gap.insertCell()
    cell.colSpan = Array.from(row.cells).reduce((total, item) => total + item.colSpan, 0)
    const guide = (cell.firstElementChild as HTMLElement | null) ?? cell.createDiv('pm-tree-drop-guide')
    guide.style.setProperty('--pm-drop-indent', `${dropIndent(row)}px`)
    let edge = row
    if (position === 'after') {
      const depth = depthOf(row)
      for (
        let next = edge.nextElementSibling as HTMLTableRowElement | null;
        next;
        next = next.nextElementSibling as HTMLTableRowElement | null
      ) {
        if (!next.matches(ROW_SELECTOR) || depthOf(next) <= depth) break
        edge = next
      }
    }
    if (position === 'before' && edge.previousElementSibling !== gap) edge.before(gap)
    if (position === 'after' && edge.nextElementSibling !== gap) edge.after(gap)
    this.gap = gap
    guide.style.setProperty('--pm-drop-height', `${this.gapHeight}px`)
  }

  private animateRows(host: HTMLElement, before: RowPositions, moving = new Set<string>(), skipMoving = false): void {
    if (host.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    for (const animation of this.rowAnimations.values()) animation.cancel()
    this.rowAnimations.clear()
    const rows = visibleRows(host)
    const positions = rows.map((row) => [row, row.getBoundingClientRect().top] as const)
    for (const [row, top] of positions) {
      const id = row.dataset.pmDragId ?? ''
      if (skipMoving && moving.has(id)) continue
      const offset = (before.get(id) ?? top) - top
      if (Math.abs(offset) < 1) continue
      const animation = row.animate(
        [{ transform: `translateY(${offset}px)` }, { transform: 'none' }],
        moving.has(id) ? LANDING : MOTION
      )
      this.rowAnimations.set(row, animation)
      animation.onfinish = () => {
        if (this.rowAnimations.get(row) === animation) this.rowAnimations.delete(row)
      }
    }
  }

  private showHint(
    row: HTMLElement,
    { parent: targetParent, changesParent, parentTitle, label: customLabel }: DropAction
  ): void {
    const label =
      customLabel ??
      (changesParent && targetParent
        ? parentTitle
          ? t(this.projects ? 'table.dropSubprojectOf' : 'table.dropSubtaskOf', { title: parentTitle })
          : t(this.projects ? 'table.dropSubproject' : 'table.dropSubtask')
        : changesParent
          ? t(this.projects ? 'table.dropRootProject' : 'table.dropRootTask')
          : t('table.dropReorder'))
    const guide = this.gap?.querySelector('.pm-tree-drop-guide')
    const wrapper = row.closest('.pm-table-wrapper')
    const host = guide ?? (wrapper && row.ownerDocument.body)
    if (!host) return
    const hint = (this.hint ??= row.ownerDocument.createElement('div'))
    hint.className = guide ? 'pm-tree-drop-hint' : 'pm-tree-drop-hint pm-tree-drop-hint--inside'
    if (hint.textContent !== label) hint.setText(label)
    if (hint.parentElement !== host) host.appendChild(hint)
    if (!guide && wrapper) {
      const viewport = wrapper.getBoundingClientRect()
      const bounds = row.getBoundingClientRect()
      const below = bounds.bottom + 32 <= viewport.bottom
      hint.style.setProperty('--pm-drop-hint-left', `${Math.max(viewport.left + 8, bounds.left + dropIndent(row))}px`)
      hint.style.setProperty('--pm-drop-hint-y', `${below ? bounds.bottom + 3 : bounds.top - 26}px`)
    }
  }

  private removeGap(): void {
    this.gap?.remove()
    this.gap = null
    this.gapTarget = null
  }

  private cancelHover(): void {
    this.pendingHover?.win.cancelAnimationFrame(this.pendingHover.frame)
    this.pendingHover = null
  }

  private clearTarget(animate = true): void {
    this.cancelHover()
    const table = this.highlighted?.closest('table')
    const before = animate && table && this.gap ? rowPositions(table) : null
    this.highlighted?.removeAttribute('data-pm-tree-drop')
    this.highlighted = null
    this.removeGap()
    this.hint?.remove()
    this.hint = null
    this.gapPosition = null
    if (table && before) this.animateRows(table, before)
  }

  private clear(animate = true): void {
    this.clearTarget(animate)
    this.source = null
    this.moving = []
    for (const item of this.dimmed) item.removeClass('pm-tree-dragging')
    this.dimmed = []
  }
}
