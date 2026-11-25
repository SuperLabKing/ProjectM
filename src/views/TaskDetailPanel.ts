import { Notice, setIcon, type Scope } from 'obsidian'
import { findTaskById, LINKED_ROW_PREFIX, t, type Project, type Task } from '@dotpm/core'
import type PMPlugin from '#main'
import { TaskEditor } from '#modals/TaskEditor'
import { LinkedTaskDetails } from './LinkedTaskDetails'

const WIDTH_KEY = 'projectm-task-details-width'
const DEFAULT_RATIO = 0.6
const EXPANDED_RATIO = 0.72
const MIN_RATIO = 0.32
const MAX_RATIO = 0.7
const clampRatio = (ratio: number) => Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio))

export class TaskDetailPanel {
  private readonly panel: HTMLElement
  private readonly mount: HTMLElement
  private readonly separator: HTMLElement
  private width: number
  private widthMotion = 0
  private expanded = false
  private editor: Pick<TaskEditor, 'flush' | 'handleClose'> | null = null
  private closingEditor: Pick<TaskEditor, 'handleClose'> | null = null
  private taskKey: string | null = null
  private rowId: string | null = null
  private request = 0

  get sideRowId(): string | null {
    return this.panel.hidden ? null : this.rowId
  }

  constructor(private layout: HTMLElement, private plugin: PMPlugin, private scope: Scope) {
    this.separator = layout.createDiv({ cls: 'pm-task-detail-resize', attr: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': t('taskEditor.resizePanel'),
      tabindex: '0'
    } })
    this.panel = layout.createEl('aside', {
      cls: 'pm-task-detail pm-te-surface',
      attr: { 'aria-label': t('common.task') }
    })
    this.mount = this.panel.createDiv('pm-task-detail-editor')
    const stored = Number(this.plugin.app.loadLocalStorage(WIDTH_KEY))
    this.width = Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_RATIO
    const setRatio = (next: number, remember = false): void => {
      this.width = clampRatio(next)
      this.expanded = false
      this.applyWidth()
      if (remember) {
        void this.settleWidth()
        this.plugin.app.saveLocalStorage(WIDTH_KEY, this.width)
      }
    }
    this.separator.setAttribute('aria-valuemin', String(MIN_RATIO * 100))
    this.separator.setAttribute('aria-valuemax', String(EXPANDED_RATIO * 100))
    this.applyWidth()
    this.separator.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      const x = event.clientX
      const startWidth = this.panel.getBoundingClientRect().width
      const layoutWidth = this.layout.clientWidth
      if (!layoutWidth) return
      const direction = this.layout.matches(':dir(rtl)') ? -1 : 1
      const win = this.separator.win
      const listeners = new AbortController()
      const options = { capture: true, signal: listeners.signal }
      let dragged = false
      listeners.signal.addEventListener('abort', () => this.layout.removeClass('pm-task-detail-resizing'))
      win.addEventListener('pointermove', (move) => {
        if (move.pointerId !== event.pointerId || move.clientX === x && !dragged) return
        if (!dragged) this.layout.addClass('pm-task-detail-resizing')
        dragged = true
        setRatio((startWidth + (x - move.clientX) * direction) / layoutWidth)
      }, options)
      const finish = (end: PointerEvent) => {
        if (end.pointerId !== event.pointerId) return
        listeners.abort()
        if (dragged) this.plugin.app.saveLocalStorage(WIDTH_KEY, this.width)
      }
      win.addEventListener('pointerup', finish, options)
      win.addEventListener('pointercancel', finish, options)
      win.addEventListener('blur', () => listeners.abort(), { signal: listeners.signal })
    })
    this.separator.addEventListener('dblclick', () => setRatio(DEFAULT_RATIO, true))
    this.separator.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      event.stopPropagation()
      const actual = this.panel.getBoundingClientRect().width
      const layoutWidth = this.layout.clientWidth
      const direction = this.layout.matches(':dir(rtl)') ? -1 : 1
      if (layoutWidth) setRatio((actual + (event.key === 'ArrowLeft' ? 16 : -16) * direction) / layoutWidth, true)
    })
    this.setVisible(false)
  }

  private applyWidth(): void {
    const ratio = this.expanded ? EXPANDED_RATIO : this.width
    // Earlier releases saved a pixel width. Preserve it until the first resize or reset.
    const width = ratio > 1 ? `${ratio}px` : `${ratio * 100}%`
    this.panel.style.setProperty('--pm-task-detail-width', width)
    const percent = ratio > 1 ? ratio / (this.layout.clientWidth || ratio / DEFAULT_RATIO) : ratio
    this.separator.setAttribute('aria-valuenow', String(Math.round(Math.min(EXPANDED_RATIO, Math.max(MIN_RATIO, percent)) * 100)))
    this.panel.toggleClass('pm-task-detail--expanded', this.expanded)
    const button = this.mount.querySelector<HTMLButtonElement>('.pm-task-panel-expand')
    if (button && button.getAttribute('aria-pressed') !== String(this.expanded)) this.updateExpandButton(button)
  }

  private updateExpandButton(button: HTMLButtonElement): void {
    const label = this.expanded ? t('taskEditor.restorePanelWidth') : t('taskEditor.expandPanel')
    button.setAttribute('aria-pressed', String(this.expanded))
    setIcon(button.children[0] as HTMLElement, this.expanded ? 'minimize-2' : 'maximize-2')
    button.children[1].setText(label)
  }

  private renderPanelActions = (header: HTMLElement): void => {
    const button = header.createEl('button', { cls: 'pm-task-panel-expand', type: 'button' })
    button.createSpan({ attr: { 'aria-hidden': 'true' } })
    button.createSpan()
    // Pressing the control with a mouse should leave the editor selection focused.
    button.addEventListener('mousedown', (event) => { if (event.button === 0) event.preventDefault() })
    button.addEventListener('click', () => this.toggleExpanded())
    this.updateExpandButton(button)
  }

  private toggleExpanded(): void {
    const positions = Array.from(this.mount.querySelectorAll<HTMLElement>('.pm-te-body, .cm-scroller, textarea')).map(
      (element) => ({ element, top: element.scrollTop, left: element.scrollLeft })
    )
    this.expanded = !this.expanded
    this.applyWidth()
    const request = this.request
    void this.settleWidth(() => {
      if (request !== this.request) return
      for (const { element, top, left } of positions) {
        element.scrollTop = top
        element.scrollLeft = left
      }
    })
  }

  private async settleWidth(after?: () => void): Promise<void> {
    const motion = ++this.widthMotion
    const transition = this.panel.getAnimations().find(
      (animation) => (animation as CSSTransition).transitionProperty === 'flex-basis'
    )
    if (transition) {
      this.panel.addClass('pm-task-detail--moving')
      const win = this.panel.win
      const duration = Number(transition.effect?.getComputedTiming().endTime ?? 0)
      let timer = 0
      try {
        await Promise.race([
          transition.finished.catch(() => undefined),
          new Promise<void>((resolve) => { timer = win.setTimeout(resolve, duration + 50) })
        ])
      } finally {
        win.clearTimeout(timer)
      }
    }
    if (motion !== this.widthMotion) return
    this.panel.removeClass('pm-task-detail--moving')
    if (!this.panel.hidden) this.mount.querySelector('.pm-modal-description')?.dispatchEvent(new Event('pm-detail-resized'))
    after?.()
  }

  private disposeClosingEditor(): void {
    const editor = this.closingEditor
    this.closingEditor = null
    editor?.handleClose()
  }

  private setVisible(visible: boolean): void {
    if (!visible) this.expanded = false
    this.panel.hidden = !visible
    this.separator.hidden = !visible
    this.panel.inert = !visible
    this.separator.inert = !visible
    this.layout.toggleClass('pm-task-detail-open', visible)
    this.applyWidth()
  }

  async open(project: Project, task: Task, onSave: (task: Task) => void | Promise<void>): Promise<void> {
    const request = ++this.request
    const key = JSON.stringify([project.filePath, task.id])
    if (this.taskKey === key) return
    if (this.editor && !(await this.editor.flush())) return
    if (request !== this.request) return
    const current = findTaskById(project, task.id) ?? task
    try {
      await this.plugin.store.loadTaskBody(current)
    } catch (error) {
      console.error('[PM]', error)
      new Notice(t('common.somethingWentWrong'))
      return
    }
    if (request !== this.request) return
    if (this.editor && !(await this.editor.flush())) return
    if (request !== this.request) return
    this.editor?.handleClose()
    this.disposeClosingEditor()
    this.taskKey = key
    this.rowId = task.id
    this.setVisible(true)
    const editor = new TaskEditor(this.plugin.app, this.plugin, project, current, null, onSave, {
      surface: 'panel',
      close: () => { void this.close() },
      renderHeaderActions: this.renderPanelActions,
      scope: this.scope
    })
    this.editor = editor
    editor.mount(this.mount)
    void this.settleWidth()
  }

  async openLinked(project: Project, id: string, path: string, onSave: () => Promise<void>): Promise<void> {
    const request = ++this.request
    const key = JSON.stringify([project.filePath, 'linked', id])
    if (this.taskKey === key) return
    if (this.editor && !(await this.editor.flush())) return
    if (request !== this.request) return
    const record = project.linkedNotes?.find((item) => item.id === id)
    if (!record) {
      new Notice(t('linkedDetails.missingRecord'))
      return
    }
    this.editor?.handleClose()
    this.disposeClosingEditor()
    this.taskKey = key
    this.rowId = LINKED_ROW_PREFIX + id
    this.setVisible(true)
    const editor = new LinkedTaskDetails(this.mount, this.plugin, project, record, path, onSave, () => {
      void this.close()
    }, this.renderPanelActions)
    this.editor = editor
    editor.mount()
    void this.settleWidth()
  }

  async close(animate = true): Promise<void> {
    const request = ++this.request
    if (this.editor && !(await this.editor.flush())) return
    if (request !== this.request) return
    const editor = this.editor
    const slide = animate && this.sideRowId !== null
    this.editor = null
    this.taskKey = null
    this.rowId = null
    this.setVisible(false)
    if (!slide) {
      editor?.handleClose()
      if (!animate) {
        void this.settleWidth()
        this.disposeClosingEditor()
      }
      return
    }
    this.closingEditor = editor
    void this.settleWidth(() => {
      if (this.closingEditor === editor) this.disposeClosingEditor()
    })
  }
}
