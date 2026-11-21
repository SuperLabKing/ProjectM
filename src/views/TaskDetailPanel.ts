import { Notice, type Scope } from 'obsidian'
import { findTaskById, t, type Project, type Task } from '@dotpm/core'
import type PMPlugin from '#main'
import { TaskEditor } from '#modals/TaskEditor'
import { LinkedTaskDetails } from './LinkedTaskDetails'

const WIDTH_KEY = 'projectm-task-details-width'
const DEFAULT_WIDTH = 410

export class TaskDetailPanel {
  private readonly panel: HTMLElement
  private readonly separator: HTMLElement
  private editor: Pick<TaskEditor, 'flush' | 'handleClose'> | null = null
  private taskKey: string | null = null
  private request = 0

  constructor(layout: HTMLElement, private plugin: PMPlugin, private scope: Scope) {
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
    const stored = Number(this.plugin.app.loadLocalStorage(WIDTH_KEY))
    let width = Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_WIDTH
    const setWidth = (next: number, remember = false) => {
      width = Math.max(260, Math.min(780, next))
      this.panel.style.setProperty('--pm-task-detail-width', width + 'px')
      this.separator.setAttribute('aria-valuenow', String(width))
      if (remember) this.plugin.app.saveLocalStorage(WIDTH_KEY, width)
    }
    this.separator.setAttribute('aria-valuemin', '260')
    this.separator.setAttribute('aria-valuemax', '780')
    setWidth(width)
    this.separator.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      const x = event.clientX
      const startWidth = this.panel.getBoundingClientRect().width
      const win = this.separator.win
      const listeners = new AbortController()
      const options = { capture: true, signal: listeners.signal }
      win.addEventListener('pointermove', (move) => {
        if (move.pointerId === event.pointerId) setWidth(startWidth + x - move.clientX)
      }, options)
      const finish = (end: PointerEvent) => {
        if (end.pointerId !== event.pointerId) return
        listeners.abort()
        setWidth(width, true)
      }
      win.addEventListener('pointerup', finish, options)
      win.addEventListener('pointercancel', finish, options)
      win.addEventListener('blur', () => listeners.abort(), { signal: listeners.signal })
    })
    this.separator.addEventListener('dblclick', () => setWidth(DEFAULT_WIDTH, true))
    this.separator.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      event.stopPropagation()
      setWidth(width + (event.key === 'ArrowLeft' ? 16 : -16), true)
    })
    this.setVisible(false)
  }

  private setVisible(visible: boolean): void {
    this.panel.hidden = !visible
    this.separator.hidden = !visible
  }

  async open(project: Project, task: Task, onSave: (task: Task) => void | Promise<void>): Promise<void> {
    const request = ++this.request
    const key = project.filePath + ':' + task.id
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
    this.taskKey = key
    this.setVisible(true)
    const editor = new TaskEditor(this.plugin.app, this.plugin, project, current, null, onSave, {
      surface: 'panel',
      close: () => { void this.close() },
      scope: this.scope
    })
    this.editor = editor
    editor.mount(this.panel)
  }

  async openLinked(project: Project, id: string, path: string, onSave: () => Promise<void>): Promise<void> {
    const request = ++this.request
    const key = project.filePath + ':linked:' + id
    if (this.taskKey === key) return
    if (this.editor && !(await this.editor.flush())) return
    if (request !== this.request) return
    const record = project.linkedNotes?.find((item) => item.id === id)
    if (!record) {
      new Notice(t('linkedDetails.missingRecord'))
      return
    }
    this.editor?.handleClose()
    this.taskKey = key
    this.setVisible(true)
    const editor = new LinkedTaskDetails(this.panel, this.plugin, project, record, path, onSave, () => {
      void this.close()
    })
    this.editor = editor
    editor.mount()
  }

  async close(): Promise<void> {
    const request = ++this.request
    if (this.editor && !(await this.editor.flush())) return
    if (request !== this.request) return
    this.editor?.handleClose()
    this.editor = null
    this.taskKey = null
    this.setVisible(false)
  }
}
