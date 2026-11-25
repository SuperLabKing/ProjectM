import { MarkdownView } from 'obsidian'
import type PMPlugin from '#main'
import { t } from '@dotpm/core'
import { safeAsync } from '@dotpm/ui'
import type { AgendaItem } from '../views/agendaEntries'
import { openTaskByPath } from './ModalFactory'
import type { WindowSource } from './agendaWindowCapture'
import { AgendaFloatWindow, watchAgendaFocus } from './agendaFloatWindow'
import { glassProperties, glassValue } from './agendaGlass'
import { AgendaRefraction } from './agendaRefraction'
import { createAgendaNoticeCard } from './agendaNoticeCard'

type AgendaTarget = Pick<AgendaItem, 'path' | 'line' | 'reminderId'>

export async function openAgendaItem(
  plugin: PMPlugin,
  item: AgendaTarget,
  { cursorAtEnd = false }: { cursorAtEnd?: boolean } = {}
): Promise<void> {
  const { vault, workspace } = plugin.app
  if (item.line === undefined) {
    const taskId = item.reminderId?.startsWith('task:') ? item.reminderId.slice(5) : undefined
    const path = (taskId && plugin.index.task(taskId)?.path) || item.path
    if (vault.getFileByPath(path)) await openTaskByPath(plugin, path)
    else plugin.showNotice(t('agenda.itemMissing'))
    return
  }
  const file = vault.getFileByPath(item.path)
  if (!file) {
    plugin.showNotice(t('agenda.itemMissing'))
    return
  }
  const line = item.reminderId ? await plugin.agendaSource.findChecklistLine(file, item.reminderId) : item.line
  const leaf = workspace.getLeaf('tab')
  await plugin.openAsMarkdown(file.path, leaf)
  if (line !== undefined && leaf.view instanceof MarkdownView) {
    const state = leaf.getViewState()
    if (state.state?.mode !== 'source') {
      await leaf.setViewState({ ...state, state: { ...state.state, mode: 'source' } })
    }
  }
  await workspace.revealLeaf(leaf)
  if (line === undefined || !(leaf.view instanceof MarkdownView)) return
  const editor = leaf.view.editor
  const row = Math.min(line, editor.lastLine())
  const position = { line: row, ch: cursorAtEnd ? editor.getLine(row).length : 0 }
  editor.setCursor(position)
  editor.scrollIntoView({ from: position, to: position }, true)
}

const POSITION_KEY = 'dotpm-agenda-notice-position'
type NoticePosition = { x: number; y: number }
type NoticeActions = { open: () => void; snooze: () => void; confirm: () => void }

export class AgendaNotices {
  private readonly mainDocument = document
  private readonly floating: AgendaFloatWindow
  private readonly refractions = new Map<HTMLElement, AgendaRefraction>()
  private desktopPreview?: AgendaFloatWindow
  private stacks = new Map<Document, HTMLElement>()
  private dismissals = new Set<() => void>()
  private pending = new Map<number, () => void>()
  private stopWatchingFocus?: () => void
  private previews = new Map<Document, () => void>()
  private previewPositions = new WeakMap<Document, NoticePosition>()
  private position: NoticePosition | null = null

  constructor(private plugin: PMPlugin) {
    this.floating = new AgendaFloatWindow(plugin)
    this.floating.setVisible(false)
    const saved = plugin.app.loadLocalStorage(POSITION_KEY) as Partial<NoticePosition> | null
    if (
      typeof saved?.x === 'number' &&
      Number.isFinite(saved.x) &&
      typeof saved.y === 'number' &&
      Number.isFinite(saved.y)
    ) {
      this.position = { x: saved.x, y: saved.y }
    }
  }

  private get style(): string {
    const saved = this.plugin.settings.agendaNoticeStyle
    return saved === 'liquid' || saved === 'frosted' ? saved : 'plain'
  }

  setWindowSource(source?: WindowSource): void {
    this.floating.setWindowSource(source)
  }

  get windowSource(): WindowSource | undefined {
    return this.floating.windowSource
  }

  syncStyle(): void {
    for (const stack of this.stacks.values()) this.applyStyle(stack)
    this.floating.refresh()
    this.desktopPreview?.refresh()
  }

  private applyStyle(stack: HTMLElement): void {
    stack.dataset.noticeStyle = this.style
    for (const card of stack.querySelectorAll<HTMLElement>(':scope > .pm-agenda-notice')) this.applyCardStyle(card)
    for (const [key, value] of Object.entries(glassProperties(this.plugin.settings))) {
      stack.style.setProperty(key, value)
    }
  }

  private applyCardStyle(card: HTMLElement): void {
    const liquid = this.style === 'liquid'
    card.toggleAttribute('data-pm-liquid-glass', liquid)
    const { agendaGlassRefraction } = this.plugin.settings
    const strength = glassValue('agendaGlassRefraction', agendaGlassRefraction)
    const reduceTransparency = card.ownerDocument.defaultView?.matchMedia(
      '(prefers-reduced-transparency: reduce)'
    ).matches
    if (!liquid || !strength || reduceTransparency) {
      this.clearRefraction(card)
      return
    }
    const refraction = this.refractions.get(card) ?? new AgendaRefraction(card)
    this.refractions.set(card, refraction)
    refraction.setStrength(strength)
  }

  private clearRefraction(card: HTMLElement): void {
    this.refractions.get(card)?.destroy()
    this.refractions.delete(card)
  }

  show(item: AgendaTarget, message: string, snoozeLabel: string, onSnooze: () => void): void {
    this.stopWatchingFocus ??= watchAgendaFocus((focusedId) => {
      if (
        focusedId !== undefined &&
        (this.floating.ownsWindow(focusedId) || this.desktopPreview?.ownsWindow(focusedId))
      )
        return
      this.floating.setVisible(focusedId === undefined)
    })
    const finish = (snoozed: boolean) => {
      const dismiss = this.pending.get(id)
      if (!dismiss) return
      this.pending.delete(id)
      dismiss()
      this.floating.remove(id)
      if (!this.pending.size) this.stopFocusTracking()
      if (snoozed) onSnooze()
    }
    const actions: NoticeActions = {
      open: safeAsync(() => openAgendaItem(this.plugin, item)),
      confirm: () => finish(false),
      snooze: () => finish(true)
    }
    const id = this.floating.show({ message, snoozeLabel, ...actions })
    this.pending.set(id, this.present(this.mainDocument, message, snoozeLabel, actions) ?? (() => {}))
  }

  preview(doc: Document, snoozeLabel: string): void {
    this.previews.get(doc)?.()
    this.present(doc, t('agenda.previewMessage'), snoozeLabel)
  }

  previewDesktop(snoozeLabel: string): void {
    this.desktopPreview?.clear()
    const preview = new AgendaFloatWindow(this.plugin, this.plugin.settings.agendaNoticeEdge ?? 'side')
    this.desktopPreview = preview
    preview.show({
      message: t('agenda.previewMessage'),
      snoozeLabel,
      fallback: () => this.plugin.showNotice(t('agenda.desktopPreviewUnavailable'))
    })
  }

  private positionStack(stack: HTMLElement, position: NoticePosition | null): void {
    if (position) {
      stack.dataset.positioned = 'true'
      stack.style.setProperty('--pm-notice-x', `${position.x}px`)
      stack.style.setProperty('--pm-notice-y', `${position.y}px`)
    } else {
      delete stack.dataset.positioned
      stack.style.removeProperty('--pm-notice-x')
      stack.style.removeProperty('--pm-notice-y')
    }
  }

  private savePosition(position: NoticePosition | null): void {
    this.position = position
    this.plugin.app.saveLocalStorage(POSITION_KEY, position)
  }

  private positionFor(doc: Document): NoticePosition | null {
    return doc === this.mainDocument ? this.position : (this.previewPositions.get(doc) ?? null)
  }

  private commitPosition(stack: HTMLElement, position: NoticePosition | null): void {
    const doc = stack.ownerDocument
    if (doc === this.mainDocument) this.savePosition(position)
    else if (position) this.previewPositions.set(doc, position)
    else this.previewPositions.delete(doc)
    this.positionStack(stack, position)
  }

  private attachDrag(header: HTMLElement, stack: HTMLElement): void {
    let drag:
      | { id: number; startX: number; startY: number; origin: NoticePosition; current?: NoticePosition }
      | undefined
    header.title = t('agenda.dragReminder')
    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || drag) return
      const { left, top } = stack.getBoundingClientRect()
      header.setPointerCapture(event.pointerId)
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, origin: { x: left, y: top } }
    })
    header.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      if (!drag.current && Math.hypot(dx, dy) < 4) return
      drag.current = { x: drag.origin.x + dx, y: drag.origin.y + dy }
      this.positionStack(stack, drag.current)
    })
    header.addEventListener('pointerup', (event) => {
      if (!drag || event.pointerId !== drag.id) return
      if (drag.current) {
        const { left, top } = stack.getBoundingClientRect()
        this.commitPosition(stack, { x: left, y: top })
      }
      drag = undefined
    })
    header.addEventListener('lostpointercapture', () => {
      if (!drag) return
      drag = undefined
      this.positionStack(stack, this.positionFor(stack.ownerDocument))
    })
    header.addEventListener('dblclick', () => this.commitPosition(stack, null))
  }

  private present(
    doc: Document,
    message: string,
    snoozeLabel: string,
    actions?: NoticeActions
  ): (() => void) | undefined {
    const win = doc.defaultView
    if (!win) return
    let stack = this.stacks.get(doc)
    if (!stack) {
      stack = doc.body.createDiv({ cls: 'pm-agenda-notice-stack', attr: { 'aria-label': t('agenda.title') } })
      this.positionStack(stack, this.positionFor(doc))
      this.stacks.set(doc, stack)
    }
    const host = stack
    this.applyStyle(host)
    const { card, header, open, snooze, confirm } = createAgendaNoticeCard(doc, {
      message,
      snoozeLabel,
      preview: !actions
    })
    host.append(card)
    this.applyCardStyle(card)
    this.attachDrag(header, host)
    if (actions && open && snooze) {
      open.addEventListener('click', actions.open)
      snooze.addEventListener('click', actions.snooze, { once: true })
    }
    const dismiss = (): void => {
      if (!this.dismissals.delete(dismiss)) return
      win.removeEventListener('pagehide', dismiss)
      this.clearRefraction(card)
      card.remove()
      if (this.previews.get(doc) === dismiss) this.previews.delete(doc)
      if (!host.childElementCount) {
        host.remove()
        this.stacks.delete(doc)
      }
    }
    this.dismissals.add(dismiss)
    if (!actions) this.previews.set(doc, dismiss)
    confirm.addEventListener('click', actions?.confirm ?? dismiss, { once: true })
    win.addEventListener('pagehide', dismiss, { once: true })
    return dismiss
  }

  private stopFocusTracking(): void {
    this.stopWatchingFocus?.()
    this.stopWatchingFocus = undefined
  }

  clear(): void {
    this.stopFocusTracking()
    this.pending.clear()
    this.floating.clear()
    this.floating.setVisible(false)
    this.desktopPreview?.clear()
    this.desktopPreview = undefined
    for (const dismiss of this.dismissals) dismiss()
  }
}
