import {
  type StatusConfig,
  type Task,
  makeTask,
  isTerminalStatus,
  getCompleteStatusId,
  getDefaultStatusId,
  t
} from '@dotpm/core'
import { renderNoteLink, Checkbox, IconButton, safeAsync } from '@dotpm/ui'
import { MarkdownRenderer, type App, Component } from 'obsidian'

interface SubtaskPreviewOptions {
  app: App
  component: Component
  loadDescription: (task: Task) => Promise<string>
  openSubtask: (filePath: string) => void
}

/** The header count is how many subtasks sit in a terminal status. */
export function renderSubtasksPanel(
  container: HTMLElement,
  task: Task,
  statuses: StatusConfig[],
  options: SubtaskPreviewOptions
): void {
  const subSection = container.createDiv('pm-modal-section')

  const subHeader = subSection.createDiv('pm-subtasks-header')
  const heading = subHeader.createEl('h4', { text: `${t('subtasks.heading')} `, cls: 'pm-modal-section-title' })
  const countEl = heading.createSpan({ cls: 'pm-subtasks-count' })

  const subList = subSection.createDiv('pm-modal-subtask-list')
  const expanded = new Set<string>()
  let previews = new Component()
  options.component.addChild(previews)

  const renderCount = () => {
    const total = task.subtasks.length
    if (total === 0) {
      countEl.setText('')
      return
    }
    const done = task.subtasks.filter((s) => isTerminalStatus(s.status, statuses)).length
    countEl.setText(`${done}/${total}`)
  }

  const renderSubtasks = () => {
    options.component.removeChild(previews)
    previews = new Component()
    options.component.addChild(previews)
    subList.empty()
    for (const sub of task.subtasks) {
      const item = subList.createDiv()
      const row = item.createDiv('pm-modal-subtask-row')

      const done = isTerminalStatus(sub.status, statuses)

      new Checkbox(row)
        .setChecked(done)
        .setAriaLabel(t('subtasks.done', { title: sub.title }))
        .onChange((checked) => {
          sub.status = checked ? getCompleteStatusId(statuses) : getDefaultStatusId(statuses)
          sub.progress = checked ? 100 : 0
          renderSubtasks()
          renderCount()
        })

      // A subtask typed into the add field below has no note yet, so there is nothing to
      // open until the editor saves.
      const cls = done ? 'pm-subtask-title pm-subtask-title--done' : 'pm-subtask-title'
      const filePath = sub.filePath
      if (filePath) {
        renderNoteLink(row, { label: sub.title, path: filePath, open: () => options.openSubtask(filePath), cls })
      } else {
        row.createSpan({ text: sub.title, cls })
      }

      const status = statuses.find((status) => status.id === sub.status)
      row.createSpan({ cls: 'pm-subtask-status', text: status?.label ?? sub.status })
      if (filePath || sub.description.trim()) {
        const toggle = new IconButton(row)
        let current: { element: HTMLElement; component: Component } | undefined
        const updatePreview = () => {
          const open = expanded.has(sub.id)
          toggle.setIcon(open ? 'chevron-up' : 'chevron-down')
          toggle.setTooltip(t(open ? 'subtasks.hidePreview' : 'subtasks.showPreview'))
          toggle.el.setAttribute('aria-expanded', String(open))
          if (!open) {
            if (current) {
              previews.removeChild(current.component)
              current.element.remove()
              current = undefined
            }
            return
          }
          const preview = item.createDiv('pm-subtask-description markdown-rendered')
          preview.setText(t('subtasks.loadingPreview'))
          const component = new Component()
          previews.addChild(component)
          current = { element: preview, component }
          safeAsync(async () => {
            try {
              const description = await options.loadDescription(sub)
              if (!preview.isConnected) return
              if (description.trim()) {
                preview.empty()
                await MarkdownRenderer.render(options.app, description, preview, filePath ?? '', component)
                preview.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((checkbox) => {
                  checkbox.disabled = true
                })
              } else preview.setText(t('subtasks.emptyPreview'))
            } catch {
              if (preview.isConnected) preview.setText(t('subtasks.previewError'))
            }
          })()
        }
        toggle.onClick(() => {
          if (!expanded.delete(sub.id)) expanded.add(sub.id)
          updatePreview()
        })
        updatePreview()
      }

      new IconButton(row)
        .setIcon('x')
        .setTooltip(t('subtasks.remove'))
        .setRevealOnHover(true)
        .onClick(() => {
          task.subtasks = task.subtasks.filter((s) => s.id !== sub.id)
          renderSubtasks()
          renderCount()
        })
    }
  }

  renderSubtasks()
  renderCount()

  const addRow = subSection.createDiv('pm-modal-subtask-row pm-subtask-add-row')
  addRow.createSpan({ cls: 'pm-subtask-checkbox-ghost', attr: { 'aria-hidden': 'true' } })
  const addInput = addRow.createEl('input', {
    cls: 'pm-subtask-add-input',
    attr: { placeholder: t('subtasks.addPlaceholder') }
  })
  addInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const title = addInput.value.trim()
    if (!title) return
    task.subtasks.push(makeTask({ title, type: 'subtask' }))
    addInput.value = ''
    renderSubtasks()
    renderCount()
  })
}
