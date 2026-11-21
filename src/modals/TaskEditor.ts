import {
  App,
  ButtonComponent,
  Component,
  ExtraButtonComponent,
  Keymap,
  type KeymapEventHandler,
  Menu,
  MarkdownRenderer,
  Notice,
  type Scope,
  setIcon,
  setTooltip
} from 'obsidian'
import type PMPlugin from '#main'
import {
  type Project,
  type Task,
  makeTask,
  flattenTasks,
  findTaskById,
  getDefaultStatusId,
  getDefaultPriorityId,
  getPriorityConfig,
  t
} from '@dotpm/core'
import { TaskFileNameConflictError } from '#store'
import { assignGroup, groupForRow, groupRoot, projectGroups, saveProjectGroups } from '#store/ProjectTaskGroups'
import { safeAsync, renderGlyph } from '@dotpm/ui'
import { saveShortcutLabel } from '../utils'
import { confirmDialog, openTaskByPath } from '#ui/ModalFactory'
import { renderTaskFormFields } from './TaskFormFields'
import { renderTimeTrackingPanel } from './TimeTrackingPanel'
import { renderSubtasksPanel } from './SubtasksPanel'
import { NoteLinkSuggest } from './NoteLinkSuggest'

/** What the editor needs from whatever surface hosts it: a modal, a tab. */
export interface TaskEditorHost {
  surface: 'modal' | 'tab' | 'panel'
  close: () => void
  /** Keymap scope the save shortcut is registered on. */
  scope: Scope
}

export class TaskEditor {
  private task: Task
  /** The task as it was when the editor opened, to diff against on save. */
  private original: Task
  private isNew: boolean
  private originalParentId: string | null
  private groupId: string | null | undefined
  private inserted = false
  private cancelled = false
  private autoSaveTimer: number | undefined
  private saveStateEl: HTMLElement | null = null
  private saveState: 'saved' | 'saving' | 'failed' = 'saved'
  private descriptionPreview: Component | null = null
  private persistPromise: Promise<void> | null = null
  private noteSuggest: NoteLinkSuggest | null = null
  private descResizeObserver: ResizeObserver | null = null
  private morePropertiesOpen = false
  private shownExtras = new Set<string>()
  private saveKeyHandler: KeymapEventHandler | null = null
  private containerEl: HTMLElement | null = null
  private titleInput: HTMLTextAreaElement | null = null
  private subtasksPreview: Component | null = null

  constructor(
    private app: App,
    private plugin: PMPlugin,
    private project: Project,
    task: Task | null,
    private parentId: string | null,
    private onSave: (task: Task) => void | Promise<void>,
    private host: TaskEditorHost,
    defaults?: Partial<Task>
  ) {
    if (task) {
      this.task = JSON.parse(JSON.stringify(task)) as Task
      this.isNew = false
      if (parentId == null) {
        const flat = flattenTasks(project.tasks)
        const entry = flat.find((f) => f.task.id === task.id)
        this.parentId = entry?.parentId ?? null
      }
    } else {
      const config = plugin.store.configFor(project)
      this.task = makeTask({
        status: getDefaultStatusId(config.statuses),
        priority: getDefaultPriorityId(config.priorities),
        type: parentId ? 'subtask' : 'task',
        ...defaults
      })
      this.isNew = true
    }
    this.original = JSON.parse(JSON.stringify(this.task)) as Task
    this.originalParentId = this.parentId
  }

  get title(): string {
    return this.task.title
  }

  mount(container: HTMLElement): void {
    this.containerEl = container
    for (const event of ['input', 'change', 'click', 'compositionend']) {
      container.addEventListener(event, this.onEditorChange)
    }
    this.render()
    if (this.host.surface !== 'panel') this.focusTitle()
  }

  private focusTitle(): void {
    window.setTimeout(() => {
      const input = this.titleInput
      if (!input) return
      input.focus()
      if (this.isNew) input.select()
    }, 0)
  }

  private onEditorChange = (event: Event): void => {
    if ((event as InputEvent).isComposing) return
    this.queueSave(event.type === 'input' || event.type === 'compositionend' ? 400 : 0)
  }

  private queueSave(delay = 0): void {
    if (this.isNew || this.cancelled || !this.containerEl) return
    if (!this.hasPendingEdits()) return
    window.clearTimeout(this.autoSaveTimer)
    this.updateSaveState('saving')
    this.autoSaveTimer = window.setTimeout(() => void this.flush(), delay)
  }

  private updateSaveState(state: typeof this.saveState): void {
    this.saveState = state
    this.saveStateEl?.setText(t(`taskEditor.autoSave.${state}` as const))
    if (this.saveStateEl) this.saveStateEl.dataset.state = state
  }

  private hasPendingEdits(): boolean {
    return this.parentId !== this.originalParentId || this.groupId !== undefined ||
      Object.keys(this.changedFields()).length > 0
  }

  async flush(): Promise<boolean> {
    window.clearTimeout(this.autoSaveTimer)
    if (this.isNew || this.cancelled) return true
    const description = this.containerEl?.querySelector('textarea.pm-modal-description')
    description?.dispatchEvent(new Event('pm-flush-description'))
    window.clearTimeout(this.autoSaveTimer)
    try {
      // Edits may arrive while an earlier snapshot is writing.
      while (this.persistPromise || this.hasPendingEdits()) {
        if (!this.task.title.trim()) {
          this.updateSaveState('failed')
          return false
        }
        this.updateSaveState('saving')
        await this.persistTask()
      }
      this.updateSaveState('saved')
      return true
    } catch (err) {
      this.updateSaveState('failed')
      if (err instanceof TaskFileNameConflictError) {
        new Notice(t('taskEditor.notSavedConflict', { name: err.fileName }))
      } else {
        console.error('[PM]', err)
        new Notice(t('common.somethingWentWrong'))
      }
      return false
    }
  }

  handleClose(): void {
    window.clearTimeout(this.autoSaveTimer)
    for (const event of ['input', 'change', 'click', 'compositionend']) {
      this.containerEl?.removeEventListener(event, this.onEditorChange)
    }
    this.descriptionPreview?.unload()
    this.descriptionPreview = null
    this.saveStateEl = null
    this.titleInput = null
    if (this.saveKeyHandler) {
      this.host.scope.unregister(this.saveKeyHandler)
      this.saveKeyHandler = null
    }
    this.noteSuggest?.destroy()
    this.noteSuggest = null
    this.descResizeObserver?.disconnect()
    this.descResizeObserver = null
    this.subtasksPreview?.unload()
    this.subtasksPreview = null
    this.containerEl?.empty()
    this.containerEl = null
  }

  private persistTask(): Promise<void> {
    if (this.persistPromise) return this.persistPromise
    const pending = this.runPersist().finally(() => {
      this.persistPromise = null
    })
    this.persistPromise = pending
    return pending
  }

  private async insertAttachments(
    descArea: HTMLTextAreaElement,
    items: { blob: Blob; name: string }[],
    autoResize: () => void
  ): Promise<void> {
    for (const { blob, name } of items) {
      try {
        const buffer = await blob.arrayBuffer()
        const file = await this.plugin.store.saveTaskAttachment(this.project, this.task, name, buffer)
        const snippet = `![[${file.name}]]`
        descArea.setRangeText(snippet, descArea.selectionStart, descArea.selectionEnd, 'end')
        this.task.description = descArea.value
        autoResize()
        if (this.containerEl) this.queueSave()
        else await this.flush()
      } catch (err) {
        console.error('Failed to save attachment', err)
        new Notice(t('taskEditor.attachmentFailed'))
      }
    }
  }

  /**
   * Only what changed. The editor works on a copy taken when it opened, so saving the
   * whole task would write its stale view of every other field back over disk.
   */
  private changedFields(): Partial<Task> {
    const patch: Partial<Task> = {}
    for (const key of Object.keys(this.task) as (keyof Task)[]) {
      if (JSON.stringify(this.task[key]) !== JSON.stringify(this.original[key])) {
        Object.assign(patch, { [key]: this.task[key] })
      }
    }
    return patch
  }

  private async runPersist(): Promise<void> {
    const parentId = this.parentId
    const requestedGroupId = this.groupId
    const groupId = parentId ? undefined : requestedGroupId
    if (groupId && !projectGroups(this.plugin, this.project).some((group) => group.id === groupId)) {
      new Notice(t('taskGroups.missing'))
      throw new Error('Selected project group no longer exists')
    }
    let taskChanged = false
    if (this.isNew) {
      if (!this.inserted) {
        await this.plugin.store.insertTask(this.project, this.task, this.parentId)
        this.inserted = true
      }
      taskChanged = true
    } else {
      const patch = structuredClone(this.changedFields())
      const savedPatch = structuredClone(patch)
      const moved = parentId !== this.originalParentId
      const patched = Object.keys(patch).length > 0
      if (patched) {
        await this.plugin.store.updateTask(this.project, this.task.id, patch)
        Object.assign(this.original, savedPatch)
        const path = findTaskById(this.project, this.task.id)?.filePath
        if (path) {
          this.task.filePath = this.original.filePath = path
          this.containerEl?.querySelector('.pm-te-footer-file-name')?.setText(path)
        }
      }
      if (moved) {
        await this.plugin.store.moveTask(this.project, this.task.id, parentId)
        this.originalParentId = parentId
      }
      taskChanged = patched || moved
    }
    if (groupId !== undefined && groupRoot(this.project, this.task.id) === this.task.id) {
      await saveProjectGroups(this.plugin, this.project, (groups) =>
        assignGroup(groups, new Set([this.task.id]), groupId)
      )
      this.plugin.refreshViews()
    }
    if (this.groupId === requestedGroupId) this.groupId = undefined
    if (!taskChanged && groupId === undefined) return
    if (taskChanged) await this.plugin.store.scheduleAfterChange(this.project, this.task.id)
    await this.onSave(this.task)
  }

  /**
   * Follows a link out of the editor. A modal closes first so it isn't left covering the note,
   * after committing its pending edits. A link opened in a new tab
   * leaves it open and the page it covers stays active, so the new tab opens in the background.
   */
  private async openNote(link: string, event?: MouseEvent): Promise<void> {
    const paneType = event ? Keymap.isModEvent(event) : false
    const modal = this.host.surface === 'modal'
    if (modal && !paneType) {
      if (!(await this.flush())) return
      this.host.close()
    }
    const covered = modal && paneType ? this.app.workspace.getMostRecentLeaf() : null
    const sourcePath = this.task.filePath || this.project.filePath || ''
    await this.app.workspace.openLinkText(link, sourcePath, paneType)
    if (covered) this.app.workspace.setActiveLeaf(covered, { focus: false })
  }

  /** A dependency leads to that task's editor, not to the markdown behind it. */
  private async openLinkedTask(filePath: string): Promise<void> {
    if (!(await this.flush())) return
    this.host.close()
    await openTaskByPath(this.plugin, filePath)
  }

  private openOverflowMenu(anchorEl: HTMLElement): void {
    const menu = new Menu()
    if (this.task.filePath) {
      const filePath = this.task.filePath
      if (this.host.surface === 'modal') {
        menu.addItem((item) =>
          item
            .setTitle(t('taskEditor.openInTab'))
            .setIcon('maximize-2')
            .onClick(
              // Moving the editor is not cancelling it, so the edits go with it.
              safeAsync(async () => {
                if (!(await this.flush())) return
                this.host.close()
                await this.plugin.router.openTask({ filePath: this.task.filePath || filePath })
              })
            )
        )
      }
      menu.addItem((item) =>
        item
          .setTitle(t('taskEditor.openAsNote'))
          .setIcon('file-text')
          .onClick(safeAsync(async () => {
            if (!(await this.flush())) return
            const current = flattenTasks(this.project.tasks).find(({ task }) => task.id === this.task.id)?.task
            this.host.close()
            await this.plugin.openAsMarkdown(current?.filePath || filePath)
          }))
      )
      menu.addSeparator()
    }
    if (this.task.archived) {
      menu.addItem((item) =>
        item
          .setTitle(t('common.unarchive'))
          .setIcon('archive-restore')
          .onClick(
            safeAsync(async () => {
              if (!(await this.flush())) return
              await this.plugin.store.unarchiveTask(this.project, this.task.id)
              new Notice(t('task.unarchived'))
              await this.onSave(this.task)
              this.cancelled = true
              this.host.close()
            })
          )
      )
    } else {
      menu.addItem((item) =>
        item
          .setTitle(t('common.archive'))
          .setIcon('archive')
          .onClick(
            safeAsync(async () => {
              if (!(await this.flush())) return
              await this.plugin.store.archiveTask(this.project, this.task.id)
              new Notice(t('task.archived'))
              await this.onSave(this.task)
              this.cancelled = true
              this.host.close()
            })
          )
      )
    }
    menu.addItem((item) =>
      item
        .setTitle(t('common.delete'))
        .setIcon('trash-2')
        .setWarning(true)
        .onClick(
          safeAsync(async () => {
            if (await confirmDialog(this.app, t('task.deleteConfirm', { title: this.task.title }))) {
              if (!(await this.flush())) return
              await this.plugin.store.deleteTask(this.project, this.task.id)
              await this.onSave(this.task)
              this.cancelled = true
              this.host.close()
            }
          })
        )
    )
    const rect = anchorEl.getBoundingClientRect()
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 })
  }

  private render(): void {
    const contentEl = this.containerEl
    if (!contentEl) return
    this.descriptionPreview?.unload()
    this.descriptionPreview = null
    contentEl.empty()

    const header = contentEl.createDiv('pm-te-header')
    const prio = getPriorityConfig(this.plugin.store.configFor(this.project).priorities, this.task.priority)
    if (prio?.color) header.setCssProps({ '--pm-accent-strip': prio.color })
    const crumb = header.createDiv('pm-te-crumb')
    if (this.project.icon) {
      renderGlyph(crumb.createSpan({ cls: 'pm-te-crumb-icon' }), { icon: this.project.icon })
    }
    crumb.createSpan({ cls: 'pm-te-crumb-name', text: this.project.title })
    const crumbSep = crumb.createSpan({ cls: 'pm-te-crumb-sep' })
    setIcon(crumbSep, 'chevron-right')
    const idEl = crumb.createSpan({ cls: 'pm-te-crumb-id pm-te-copyable', text: this.task.id })
    setTooltip(idEl, t('taskEditor.copyId'))
    idEl.addEventListener(
      'click',
      safeAsync(async () => {
        await navigator.clipboard.writeText(this.task.id)
        new Notice(t('taskEditor.copiedId'))
      })
    )

    header.createDiv('pm-te-header-spacer')
    if (!this.isNew) {
      this.saveStateEl = header.createSpan({ cls: 'pm-te-save-state', attr: { role: 'status' } })
      this.updateSaveState(this.saveState)
    }

    if (!this.isNew) {
      const moreBtn = new ExtraButtonComponent(header)
        .setIcon('more-horizontal')
        .setTooltip(t('taskEditor.moreActions'))
      moreBtn.extraSettingsEl.addClass('pm-te-header-btn')
      moreBtn.onClick(() => this.openOverflowMenu(moreBtn.extraSettingsEl))
    }
    const closeBtn = new ExtraButtonComponent(header).setIcon('x').setTooltip(t('common.close'))
    closeBtn.extraSettingsEl.addClass('pm-te-header-btn')
    closeBtn.onClick(() => this.host.close())

    const body = contentEl.createDiv('pm-te-body')

    const titleWrap = body.createDiv('pm-te-title-wrap')
    const titleInput = titleWrap.createEl('textarea', { cls: 'pm-te-title' })
    this.titleInput = titleInput
    titleInput.rows = 1
    titleInput.value = this.task.title
    titleInput.placeholder = t('taskEditor.titlePlaceholder')
    titleInput.spellcheck = false
    const autosizeTitle = () => {
      titleInput.setCssProps({ '--te-title-height': 'auto' })
      titleInput.setCssProps({ '--te-title-height': titleInput.scrollHeight + 'px' })
    }
    const titleError = titleWrap.createDiv({ cls: 'pm-modal-title-error', attr: { hidden: '' } })
    const clearTitleError = () => {
      if (titleError.hasAttribute('hidden')) return
      titleError.setAttribute('hidden', '')
      titleError.setText('')
      titleInput.classList.remove('pm-input-error')
    }
    const showTitleError = (message: string) => {
      titleError.setText(message)
      titleError.removeAttribute('hidden')
      titleInput.classList.add('pm-input-error')
      titleInput.focus()
      titleInput.select()
    }
    titleInput.addEventListener('input', () => {
      this.task.title = titleInput.value
      clearTitleError()
      autosizeTitle()
    })
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !Keymap.isModifier(e, this.plugin.settings.editorSaveModifier)) e.preventDefault()
    })
    window.setTimeout(autosizeTitle, 0)

    const props = body.createDiv('pm-te-props')
    const inherited =
      !!this.parentId ||
      (!this.isNew && groupRoot(this.project, this.task.id) !== this.task.id && this.parentId === this.originalParentId)
    const currentGroup = groupForRow(this.plugin, this.project, this.parentId ?? this.task.id)
    renderTaskFormFields(props, {
      task: this.task,
      project: this.project,
      plugin: this.plugin,
      parentId: this.parentId,
      setParentId: (id) => {
        this.parentId = id
      },
      groupId: inherited
        ? (currentGroup?.id ?? null)
        : this.groupId === undefined
          ? (currentGroup?.id ?? null)
          : this.groupId,
      groupInherited: inherited,
      setGroupId: (id) => {
        this.groupId = id
      },
      rerender: () => {
        this.render()
        this.queueSave()
      },
      moreOpen: this.morePropertiesOpen,
      setMoreOpen: (open) => { this.morePropertiesOpen = open },
      changed: () => this.queueSave(),
      shownExtras: this.shownExtras,
      openTask: (path) => { void this.openLinkedTask(path) }
    })

    const summarySection = body.createEl('label', { cls: 'pm-te-summary' })
    summarySection.createSpan({ text: t('common.description'), cls: 'pm-modal-section-title' })
    const summaryInput = summarySection.createEl('textarea', { cls: 'pm-te-summary-input', attr: { rows: '2' } })
    summaryInput.value = this.task.summary ?? ''
    summaryInput.placeholder = t('taskEditor.summaryPlaceholder')
    summaryInput.addEventListener('input', () => {
      this.task.summary = summaryInput.value.trim()
    })

    const descSection = body.createDiv('pm-modal-section pm-modal-desc-section')
    descSection.createEl('h4', { text: t('taskEditor.details'), cls: 'pm-modal-section-title' })

    const descPreview = descSection.createDiv('pm-modal-desc-preview')
    const descArea = descSection.createEl('textarea', { cls: 'pm-modal-description' })
    descArea.placeholder = t('taskEditor.detailsPlaceholder')
    descArea.value = this.task.description

    const autoResize = () => {
      const saved: [HTMLElement, number][] = []
      let ancestor = descArea.parentElement
      while (ancestor) {
        if (ancestor.scrollTop > 0) saved.push([ancestor, ancestor.scrollTop])
        ancestor = ancestor.parentElement
      }
      descArea.setCssProps({ '--desc-height': 'auto' })
      const borders = descArea.offsetHeight - descArea.clientHeight
      descArea.setCssProps({ '--desc-height': descArea.scrollHeight + borders + 'px' })
      for (const [el, top] of saved) el.scrollTop = top
    }

    let measuredWidth = 0
    this.descResizeObserver?.disconnect()
    this.descResizeObserver = new ResizeObserver(() => {
      if (descArea.clientWidth === measuredWidth) return
      measuredWidth = descArea.clientWidth
      if (!descArea.classList.contains('pm-hidden')) autoResize()
    })
    this.descResizeObserver.observe(descArea)

    const hasContent = () => this.task.description.trim().length > 0
    const sourcePath = this.task.filePath || this.project.filePath || ''

    let descComp = new Component()
    descComp.load()
    this.descriptionPreview = descComp

    const toggleCheckbox = (index: number) => {
      let count = 0
      this.task.description = this.task.description.replace(
        /^([ \t]*[-*+] \[)([ x])(\])/gm,
        (match, pre, state, post) => {
          if (count++ === index) return pre + (state === ' ' ? 'x' : ' ') + post
          return match
        }
      )
      descArea.value = this.task.description
      void renderPreview()
    }

    const attachCheckboxListeners = () => {
      descPreview.querySelectorAll('input[type="checkbox"]').forEach((el, i) => {
        const cb = el as HTMLInputElement
        cb.removeAttribute('disabled')
        cb.addEventListener('click', (e) => {
          e.preventDefault()
          toggleCheckbox(i)
        })
      })
    }

    // Electron silently drops file:// under the target="_blank" MarkdownRenderer emits.
    const attachFileLinkHandlers = () => {
      descPreview.querySelectorAll<HTMLAnchorElement>('a.external-link').forEach((a) => {
        if (!a.href.startsWith('file://')) return
        a.addEventListener('click', (e) => {
          e.preventDefault()
          activeWindow.open(a.href)
        })
      })
    }

    const renderPreview = async () => {
      descComp.unload()
      descComp = new Component()
      descComp.load()
      this.descriptionPreview = descComp
      descPreview.empty()
      await MarkdownRenderer.render(this.app, this.task.description, descPreview, sourcePath, descComp)
      attachCheckboxListeners()
      attachFileLinkHandlers()
    }

    const showEdit = (caret?: number) => {
      descPreview.classList.add('pm-hidden')
      descArea.classList.remove('pm-hidden')
      descArea.value = this.task.description
      window.setTimeout(() => {
        autoResize()
        descArea.focus()
        if (caret !== undefined) descArea.setSelectionRange(caret, caret)
      }, 0)
    }

    const showPreview = () => {
      if (!hasContent()) return
      void renderPreview()
      descArea.classList.add('pm-hidden')
      descPreview.classList.remove('pm-hidden')
    }

    descArea.addEventListener('input', () => {
      this.task.description = descArea.value
      autoResize()
    })
    descArea.addEventListener('blur', () => showPreview())

    descArea.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items
      if (!items) return
      const attachments: { blob: Blob; name: string }[] = []
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-')
            const sub = (item.type.split('/')[1] || 'png').split('+')[0]
            const ext = sub === 'jpeg' ? 'jpg' : sub
            attachments.push({ blob: file, name: `Pasted-${stamp}.${ext}` })
          }
        }
      }
      if (attachments.length === 0) return
      e.preventDefault()
      void this.insertAttachments(descArea, attachments, autoResize)
    })

    descSection.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return
      if (!Array.from(e.dataTransfer.types).includes('Files')) return
      e.preventDefault()
    })

    descSection.addEventListener('drop', (e) => {
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      e.preventDefault()
      if (descArea.classList.contains('pm-hidden')) {
        showEdit()
        descArea.selectionStart = descArea.selectionEnd = descArea.value.length
      }
      const attachments = Array.from(files).map((f) => ({ blob: f, name: f.name }))
      void this.insertAttachments(descArea, attachments, autoResize)
    })

    this.noteSuggest?.destroy()
    this.noteSuggest = new NoteLinkSuggest(this.app, descArea, (newValue) => {
      this.task.description = newValue
      autoResize()
      this.queueSave()
    })
    this.noteSuggest.attach(descSection)

    // Walk rendered text and markdown source in step, skipping source characters that
    // produced no output, so a caret in the preview lands past the syntax around it.
    const sourceOffsetOf = (renderedIndex: number) => {
      const rendered = descPreview.textContent || ''
      const src = this.task.description
      const plain = (c: string) => (/\s/.test(c) ? ' ' : c)
      let cursor = 0
      for (let i = 0; i < renderedIndex && i < rendered.length; i++) {
        const ch = plain(rendered[i])
        while (cursor < src.length && plain(src[cursor]) !== ch) cursor++
        cursor++
      }
      return Math.min(cursor, src.length)
    }

    const clickedSourceOffset = (e: MouseEvent) => {
      const doc = descPreview.ownerDocument
      const caret = doc.caretPositionFromPoint?.(e.clientX, e.clientY)
      const node = caret?.offsetNode
      if (!node || node.nodeType !== Node.TEXT_NODE || !descPreview.contains(node)) return undefined
      const walker = doc.createTreeWalker(descPreview, NodeFilter.SHOW_TEXT)
      let rendered = 0
      let current = walker.nextNode()
      while (current && current !== node) {
        rendered += (current.textContent || '').length
        current = walker.nextNode()
      }
      return current ? sourceOffsetOf(rendered + caret.offset) : undefined
    }

    descPreview.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.instanceOf(HTMLInputElement) && target.type === 'checkbox') return

      const link = target.closest('a')

      if (link) {
        if (link.classList.contains('internal-link')) {
          e.preventDefault()
          e.stopPropagation()
          void this.openNote(link.getAttribute('data-href') || link.getAttribute('href') || '', e)
          return
        }
        return
      }

      if (target.instanceOf(HTMLImageElement)) return

      const selection = activeWindow.getSelection()
      if (selection && !selection.isCollapsed && descPreview.contains(selection.anchorNode)) return

      showEdit(clickedSourceOffset(e))
    })

    if (hasContent()) {
      descArea.classList.add('pm-hidden')
      void renderPreview()
    } else {
      descPreview.classList.add('pm-hidden')
      window.setTimeout(autoResize, 0)
    }

    this.subtasksPreview?.unload()
    const subtasksPreview = new Component()
    subtasksPreview.load()
    this.subtasksPreview = subtasksPreview
    renderSubtasksPanel(body, this.task, this.plugin.store.configFor(this.project).statuses, {
      app: this.app,
      component: subtasksPreview,
      loadDescription: async (subtask) => {
        if (!subtask.filePath) return subtask.description
        const preview = { ...subtask }
        await this.plugin.store.loadTaskBody(preview)
        return preview.description
      },
      changed: () => this.queueSave(),
      openSubtask: (path) => { void this.openLinkedTask(path) }
    })

    renderTimeTrackingPanel(body, this.task)

    const footer = contentEl.createDiv('pm-te-footer')

    if (!this.isNew && this.task.filePath) {
      const filePath = this.task.filePath
      const pathHint = footer.createSpan({ cls: 'pm-te-footer-path pm-te-copyable' })
      const fileIcon = pathHint.createSpan({ cls: 'pm-te-footer-icon' })
      setIcon(fileIcon, 'file-text')
      pathHint.createSpan({ cls: 'pm-te-footer-file-name', text: filePath })
      setTooltip(pathHint, t('taskEditor.copyPath'))
      pathHint.addEventListener(
        'click',
        safeAsync(async () => {
          await navigator.clipboard.writeText(this.task.filePath || filePath)
          new Notice(t('taskEditor.copiedPath'))
        })
      )
    }

    if (!this.isNew) {
      footer.toggleClass('pm-hidden', !this.task.filePath)
      return
    }
    footer.createDiv('pm-footer-spacer')

    new ButtonComponent(footer).setButtonText(t('common.cancel')).onClick(() => {
      this.cancelled = true
      this.host.close()
    })

    const modifier = this.plugin.settings.editorSaveModifier
    const saveBtn = new ButtonComponent(footer)
      .setButtonText(t(this.isNew ? 'taskEditor.create' : 'taskEditor.save', { shortcut: saveShortcutLabel(modifier) }))
      .setCta()
    let saving = false
    const doSave = async () => {
      if (saving) return
      saving = true
      try {
        if (!this.task.title.trim()) {
          titleInput.focus()
          titleInput.classList.add('pm-input-error')
          return
        }
        clearTitleError()
        await this.persistTask()
        this.host.close()
      } catch (err) {
        if (err instanceof TaskFileNameConflictError) {
          showTitleError(t('taskEditor.titleConflict', { name: err.fileName }))
          return
        }
        console.error('[PM]', err)
        new Notice(t('common.somethingWentWrong'))
      } finally {
        saving = false
      }
    }

    saveBtn.onClick(() => {
      void doSave()
    })

    if (this.saveKeyHandler) this.host.scope.unregister(this.saveKeyHandler)
    this.saveKeyHandler = this.host.scope.register([modifier], 'Enter', () => {
      void doSave()
      return false
    })
  }
}
