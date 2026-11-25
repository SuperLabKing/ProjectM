import { Component, getFrontMatterInfo, MarkdownRenderer, Notice, setIcon } from 'obsidian'
import { LINKED_ROW_PREFIX, t, type LinkedNote, type Project } from '@dotpm/core'
import type PMPlugin from '#main'
import { assignGroup, groupForRow, groupRoot, projectGroups, saveProjectGroups } from '#store/ProjectTaskGroups'

export class LinkedTaskDetails {
  private readonly previewComponent = new Component()
  private pending: Promise<boolean> | null = null
  private savedStatus: string
  private savedGroup: string
  private status!: HTMLSelectElement
  private group!: HTMLSelectElement
  private indicator!: HTMLElement

  constructor(
    private panel: HTMLElement,
    private plugin: PMPlugin,
    private project: Project,
    private record: LinkedNote,
    private path: string,
    private onSave: () => Promise<void>,
    private close: () => void,
    private renderHeaderActions?: (header: HTMLElement) => void
  ) {
    this.savedStatus = record.status
    this.savedGroup = groupForRow(plugin, project, this.rowId)?.id ?? ''
  }

  private get rowId(): string {
    return LINKED_ROW_PREFIX + this.record.id
  }

  mount(): void {
    this.panel.empty()
    const header = this.panel.createDiv('pm-te-header')
    header.createSpan({ text: t('linkedDetails.title') })
    header.createDiv('pm-te-header-spacer')
    this.indicator = header.createSpan({ cls: 'pm-te-save-state', attr: { role: 'status' } })
    this.setSaveState('saved')
    this.renderHeaderActions?.(header)
    const close = header.createEl('button', {
      cls: 'clickable-icon pm-te-header-btn',
      type: 'button',
      attr: { 'aria-label': t('common.close') }
    })
    setIcon(close, 'x')
    close.addEventListener('click', this.close)

    const body = this.panel.createDiv('pm-te-body pm-linked-details')
    const file = this.plugin.app.vault.getFileByPath(this.path)
    body.createEl('h3', { text: file?.basename ?? this.path.split('/').at(-1) ?? this.path })
    const props = body.createDiv('pm-linked-details-fields')
    const statuses = this.plugin.store.configFor(this.project).statuses.map(({ id, label }) => [id, label] as const)
    if (!statuses.some(([id]) => id === this.savedStatus)) statuses.push([this.savedStatus, this.savedStatus])
    this.status = this.field(props, t('taskForm.status'), 'status', statuses, this.savedStatus)
    const groups = projectGroups(this.plugin, this.project).map(({ id, name }) => [id, name] as const)
    this.group = this.field(props, t('taskGroups.field'), 'group', [['', t('taskGroups.ungrouped')], ...groups], this.savedGroup)
    const inherited = groupRoot(this.project, this.rowId) !== this.rowId
    this.group.disabled = inherited || groups.length === 0
    if (inherited) this.group.title = t('linkedDetails.inheritedGroup')

    const open = body.createEl('button', { type: 'button', cls: 'pm-linked-details-open' })
    setIcon(open.createSpan(), 'external-link')
    open.createSpan({ text: t('linkedDetails.openNote') })
    open.disabled = !file
    open.addEventListener('click', () => {
      void this.flush().then(async (saved) => {
        if (saved) await this.plugin.openAsMarkdown(this.path)
      })
    })
    body.createEl('h4', { text: t('linkedDetails.preview'), cls: 'pm-modal-section-title' })
    const preview = body.createDiv({ cls: 'markdown-rendered pm-linked-details-preview', attr: { inert: '' } })
    this.previewComponent.load()
    if (!file) preview.setText(t('linkedDetails.missingNote'))
    else {
      void this.plugin.app.vault.cachedRead(file).then(async (source) => {
        if (!preview.isConnected) return
        await MarkdownRenderer.render(
          this.plugin.app, source.slice(getFrontMatterInfo(source).contentStart), preview, file.path, this.previewComponent
        )
      }).catch(() => {
        if (preview.isConnected) preview.setText(t('linkedDetails.missingNote'))
      })
    }
  }

  private field(
    parent: HTMLElement, label: string, role: string, options: ReadonlyArray<readonly [string, string]>, value: string
  ): HTMLSelectElement {
    const wrap = parent.createEl('label')
    wrap.createSpan({ text: label, cls: 'pm-prop-label' })
    const select = wrap.createEl('select', { cls: 'dropdown', attr: { 'data-role': role } })
    for (const [id, text] of options) select.createEl('option', { value: id, text })
    select.value = value
    select.addEventListener('change', () => { void this.flush() })
    return select
  }

  private setSaveState(state: 'saving' | 'saved' | 'failed'): void {
    this.indicator.dataset.state = state
    this.indicator.setText(t(`taskEditor.autoSave.${state}` as const))
  }

  flush(): Promise<boolean> {
    if (this.pending) return this.pending
    this.pending = this.persist().finally(() => { this.pending = null })
    return this.pending
  }

  private async persist(): Promise<boolean> {
    try {
      while (this.status.value !== this.savedStatus || this.group.value !== this.savedGroup) {
        const status = this.status.value
        const group = this.group.value
        this.setSaveState('saving')
        if (status !== this.savedStatus) {
          await this.plugin.store.updateLinkedNotes(this.project, (notes) =>
            notes.map((item) => item.id === this.record.id ? { ...item, status } : item)
          )
          this.savedStatus = status
        }
        if (group !== this.savedGroup) {
          if (groupRoot(this.project, this.rowId) !== this.rowId) throw new Error(t('linkedDetails.inheritedGroup'))
          await saveProjectGroups(this.plugin, this.project, (groups) => {
            if (group && !groups.some((item) => item.id === group)) throw new Error(t('taskGroups.missing'))
            return assignGroup(groups, new Set([this.rowId]), group || null)
          })
          this.savedGroup = group
        }
        await this.onSave()
      }
      this.setSaveState('saved')
      return true
    } catch (error) {
      console.error('[PM] Could not save linked task details', error)
      this.setSaveState('failed')
      new Notice(t('common.somethingWentWrong'))
      return false
    }
  }

  handleClose(): void {
    this.previewComponent.unload()
    this.panel.empty()
  }
}
