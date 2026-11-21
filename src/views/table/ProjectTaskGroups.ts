import { Modal, Setting, setIcon } from 'obsidian'
import { makeId, t, type ProjectTaskGroup, LINKED_ROW_PREFIX, linkedTaskState, planTaskRowMove } from '@dotpm/core'
import { ProgressBar, renderGlyph, renderIconControl, safeAsync } from '@dotpm/ui'
import { confirmDialog } from '#ui/ModalFactory'
import { assignGroup, groupForRow, groupRoot, projectGroups, saveProjectGroups } from '#store/ProjectTaskGroups'
import type { TableContext, TableTreeRow } from './TableRenderer'
import type { TreeDrop } from '../TreeRowDrag'
import { animateTableFold } from './animateTableFold'

const PREFIX = 'projectm-group:'
const UNGROUPED = PREFIX + 'ungrouped'

export function isGroupRow(id: string): boolean {
  return id.startsWith(PREFIX)
}

type GroupProgress = { processed: number; total: number }
type GroupRow = { id: string; group?: ProjectTaskGroup; progress?: GroupProgress }
export type TableDisplayRow = TableTreeRow | GroupRow

export function groupsFor(ctx: TableContext): ProjectTaskGroup[] {
  const project = ctx.scope.spec.kind === 'project' ? ctx.scope.primary : null
  return project ? projectGroups(ctx.plugin, project) : []
}

export function groupRows(rows: TableTreeRow[], ctx: TableContext): TableDisplayRow[] {
  const groups = groupsFor(ctx)
  const project = ctx.scope.spec.kind === 'project' ? ctx.scope.primary : null
  if (!project) return rows
  const ungroupedCollapsed = ctx.plugin.settings.collapsedUngroupedProjects.includes(project.id)
  if (!groups.length) return [{ id: UNGROUPED }, ...(ungroupedCollapsed ? [] : rows)]
  const memberships = new Map(groups.flatMap((group) => group.members.map((id) => [id, group.id] as const)))
  const progress = new Map<string, GroupProgress>()
  const statuses = new Map(ctx.statuses.map((status) => [status.id, status]))
  const count = (id: string, status: string) => {
    const root = groupRoot(project, id)
    const group = root && memberships.get(root)
    if (!group) return
    const value = progress.get(group) ?? { processed: 0, total: 0 }
    const state = linkedTaskState(status, statuses.get(status))
    value.total++
    if (state === 'done' || state === 'cancel') value.processed++
    progress.set(group, value)
  }
  for (const [id, { task }] of project.taskIndex) {
    if (!task.archived) count(id, task.status)
  }
  for (const note of project.linkedNotes ?? []) {
    count(LINKED_ROW_PREFIX + note.id, note.status)
  }
  const buckets = new Map<string, TableTreeRow[]>()
  const roots = new Map<string, string>()
  for (const row of rows) {
    const id = row.task.id
    const parentGroup = row.parentId && roots.get(row.parentId)
    const root = parentGroup ? null : groupRoot(project, id)
    const group = parentGroup || (root && memberships.get(root)) || UNGROUPED
    roots.set(id, group)
    const bucket = buckets.get(group) ?? []
    bucket.push(row)
    buckets.set(group, bucket)
  }
  return [
    { id: UNGROUPED },
    ...(ungroupedCollapsed ? [] : (buckets.get(UNGROUPED) ?? [])),
    ...groups.flatMap((group) => [
      { id: PREFIX + group.id, group, progress: progress.get(group.id) ?? { processed: 0, total: 0 } },
      ...(group.collapsed ? [] : (buckets.get(group.id) ?? []))
    ])
  ]
}

export function groupDrop(ctx: TableContext, sources: string[], target: string) {
  const project = ctx.scope.primary
  if (!isGroupRow(target) || ctx.scope.spec.kind !== 'project' || !project) return null
  const groups = groupsFor(ctx)
  const group = groups.find((item) => PREFIX + item.id === target)
  if (!groups.length || (!group && target !== UNGROUPED)) return null
  const selected = new Set(sources)
  const roots = sources.map((id) => groupRoot(project, id))
  if (roots.some((root) => root === null)) return null
  const nested = roots.some((root) => root && !selected.has(root))
  const plan = nested && ctx.manualOrder ? planTaskRowMove(project, sources, null, 'inside') : null
  if (nested && !plan) return null
  const ids = new Set(plan?.movedIds ?? roots.filter((root): root is string => root !== null))
  const changed = [...ids].some((id) => groupForRow(ctx.plugin, project, id)?.id !== group?.id)
  return changed || plan?.changesParent ? { ids, group, detach: !!plan, changed } : null
}

function groupReorder(ctx: TableContext, sources: string[], target: string, position: TreeDrop) {
  const [source] = sources
  if (sources.length !== 1 || !isGroupRow(source) || !isGroupRow(target) || position === 'inside') return null
  const groups = groupsFor(ctx)
  const from = groups.findIndex((group) => PREFIX + group.id === source)
  const to = groups.findIndex((group) => PREFIX + group.id === target)
  if (from < 0 || to < 0 || from === to) return null
  const index = to + Number(position === 'after') - Number(from < to)
  return index !== from ? { from, index } : null
}

export function groupDropLabel(
  ctx: TableContext,
  sources: string[],
  target: string,
  position: TreeDrop
): string | null {
  if (sources.some(isGroupRow)) {
    return groupReorder(ctx, sources, target, position) ? t('taskGroups.reorder') : null
  }
  const drop = groupDrop(ctx, sources, target)
  if (!drop) return null
  if (drop.detach) {
    const title = drop.group?.name ?? t('taskGroups.ungrouped')
    return t(drop.changed ? 'taskGroups.detachTo' : 'taskGroups.detachHere', { title })
  }
  return drop.group ? t('taskGroups.moveTo', { title: drop.group.name }) : t('taskGroups.moveOut')
}

export function groupOf(ctx: TableContext, id: string): string | undefined {
  const project = ctx.scope.primary
  return project ? groupForRow(ctx.plugin, project, id)?.id : undefined
}

async function updateGroups(ctx: TableContext, update: (groups: ProjectTaskGroup[]) => ProjectTaskGroup[]) {
  const project = ctx.scope.primary
  if (!project) return
  await saveProjectGroups(ctx.plugin, project, update)
  await ctx.onRefresh()
}

export async function moveToGroup(ctx: TableContext, sources: string[], target: string): Promise<void> {
  const drop = groupDrop(ctx, sources, target)
  const project = ctx.scope.primary
  if (!drop || !project) return
  if (drop.detach && !(await ctx.plugin.store.moveTaskRows(project, [...drop.ids], null, 'inside'))) return
  await updateGroups(ctx, (groups) =>
    assignGroup(groups, drop.ids, drop.group?.id ?? null).map((group) =>
      group.id === drop.group?.id ? { ...group, collapsed: false } : group
    )
  )
}

export async function moveGroupRows(
  ctx: TableContext,
  sources: string[],
  target: string,
  position: TreeDrop
): Promise<void> {
  if (!sources.some(isGroupRow)) {
    await moveToGroup(ctx, sources, target)
    return
  }
  const move = groupReorder(ctx, sources, target, position)
  if (!move) return
  await updateGroups(ctx, (groups) => {
    const next = [...groups]
    const [group] = next.splice(move.from, 1)
    next.splice(move.index, 0, group)
    return next
  })
}

export function openGroupEditor(ctx: TableContext, group?: ProjectTaskGroup): void {
  const modal = new Modal(ctx.plugin.app)
  modal.setTitle(t(group ? 'taskGroups.edit' : 'taskGroups.add'))
  let name = group?.name ?? ''
  let description = group?.description ?? ''
  let icon = group?.icon ?? ''
  const form = modal.contentEl.createEl('form')
  let nameInput: HTMLInputElement | undefined
  new Setting(form).setName(t('taskGroups.name')).addText((field) => {
    nameInput = field.inputEl
    nameInput.required = true
    field.setValue(name).onChange((value) => {
      name = value
    })
  })
  new Setting(form).setName(t('taskGroups.description')).addTextArea((field) => {
    field.setValue(description).onChange((value) => {
      description = value
    })
  })
  const iconSetting = new Setting(form).setName(t('project.icon'))
  renderIconControl({
    container: iconSetting.controlEl,
    value: icon,
    onChange: (value) => {
      icon = value
    }
  })
  const iconTrigger = iconSetting.controlEl.querySelector('button')
  if (iconTrigger) {
    iconTrigger.type = 'button'
    iconTrigger.setAttribute('aria-label', t('project.icon'))
  }
  const actions = form.createDiv('modal-button-container')
  if (group) {
    const remove = actions.createEl('button', {
      text: t('taskGroups.delete'),
      type: 'button',
      cls: 'mod-warning'
    })
    remove.addEventListener(
      'click',
      safeAsync(async () => {
        remove.disabled = true
        try {
          const confirmed = await confirmDialog(ctx.plugin.app, t('taskGroups.deleteConfirm', { title: group.name }))
          if (!confirmed) return
          await updateGroups(ctx, (groups) => groups.filter((item) => item.id !== group.id))
          modal.close()
        } finally {
          remove.disabled = false
        }
      })
    )
  }
  actions
    .createEl('button', { text: t('common.cancel'), type: 'button' })
    .addEventListener('click', () => modal.close())
  const save = actions.createEl('button', { text: t('taskGroups.save'), type: 'submit', cls: 'mod-cta' })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const title = name.trim()
    if (!title || save.disabled) return
    save.disabled = true
    safeAsync(async () => {
      try {
        await updateGroups(ctx, (groups) =>
          group
            ? groups.map((item) =>
                item.id === group.id ? { ...item, name: title, description: description.trim(), icon } : item
              )
            : [
                ...groups,
                { id: makeId(), name: title, description: description.trim(), icon, collapsed: false, members: [] }
              ]
        )
        modal.close()
      } finally {
        save.disabled = false
      }
    })()
  })
  modal.open()
  nameInput?.focus()
}

export function renderGroupRow(tbody: HTMLElement, row: GroupRow, ctx: TableContext, colCount: number): void {
  const { group, id, progress } = row
  const tr = tbody.createEl('tr', { cls: 'pm-table-row pm-task-group-row' })
  tr.dataset.pmFoldRow = id
  const cell = tr.createEl('td', { attr: { colspan: String(colCount) } })
  const content = cell.createDiv('pm-task-group-content')
  const project = ctx.scope.primary
  const name = group?.name ?? t('taskGroups.ungrouped')
  const collapsed = group
    ? group.collapsed === true
    : !!project && ctx.plugin.settings.collapsedUngroupedProjects.includes(project.id)
  const toggle = content.createEl('button', { cls: 'clickable-icon pm-task-group-toggle', type: 'button' })
  setIcon(toggle, collapsed ? 'chevron-right' : 'chevron-down')
  toggle.setAttribute('aria-expanded', String(!collapsed))
  toggle.setAttribute('aria-label', name)
  toggle.addEventListener(
    'click',
    safeAsync(() =>
      animateTableFold(ctx.state.wrapper, tbody, id, !collapsed, async () => {
        if (group) {
          await updateGroups(ctx, (groups) =>
            groups.map((item) => (item.id === group.id ? { ...item, collapsed: !collapsed } : item))
          )
        } else if (project) {
          const settings = ctx.plugin.settings
          const ids = new Set(settings.collapsedUngroupedProjects)
          if (collapsed) ids.delete(project.id)
          else ids.add(project.id)
          settings.collapsedUngroupedProjects = [...ids]
          await ctx.plugin.saveSettings()
          await ctx.onRefresh()
        }
      })
    )
  )
  if (group?.icon) renderGlyph(content, { icon: group.icon })
  if (!group) {
    const icon = content.createSpan({ cls: 'pm-task-group-ungrouped-icon', attr: { 'aria-hidden': 'true' } })
    setIcon(icon, 'inbox')
  }
  content.createSpan({ cls: 'pm-task-group-name', text: name })
  if (group?.description) {
    content.createSpan({
      cls: 'pm-task-group-description',
      text: group.description,
      attr: { title: group.description }
    })
  }
  if (group) {
    if (progress) {
      const { processed, total } = progress
      const percent = total ? Math.round((processed * 100) / total) : 0
      const summary = t('taskGroups.progress', { processed, total, percent })
      const wrap = content.createDiv('pm-task-group-progress')
      const bar = new ProgressBar(wrap).setSize('sm').setValue(percent)
      bar.el.setAttribute('role', 'progressbar')
      bar.el.setAttribute('aria-label', group.name)
      bar.el.setAttribute('aria-valuenow', String(percent))
      bar.el.setAttribute('aria-valuetext', summary)
      wrap.createSpan({ text: summary, attr: { 'aria-hidden': 'true' } })
    }
    const edit = content.createEl('button', {
      cls: 'clickable-icon pm-task-group-edit',
      type: 'button',
      attr: { 'aria-label': t('taskGroups.edit') }
    })
    setIcon(edit, 'pencil')
    edit.addEventListener('click', () => openGroupEditor(ctx, group))
  }
  if (group) tr.addClass('pm-task-group-row--draggable')
  ctx.state.rowDrag?.attach(tr, id, {
    section: true,
    targetOnly: !group,
    dropPosition: (source, position, offset) =>
      isGroupRow(source) ? (position === 'inside' ? (offset < 0.5 ? 'before' : 'after') : position) : 'inside'
  })
}
