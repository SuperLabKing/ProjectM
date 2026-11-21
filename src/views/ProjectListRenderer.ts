import { Menu } from 'obsidian'
import type PMPlugin from '#main'
import { folderOf, projectFolderOf, type ProjectRef } from '#store'
import {
  type PMSettings,
  type ProjectGroupBy,
  type ProjectListField,
  type ProjectListGroup,
  type ProjectListItem,
  type ProjectListRow,
  formatDateShort,
  formatDateLong,
  dateUrgency,
  t
} from '@dotpm/core'
import { safeAsync, CollapseToggle, ProjectRow, projectFieldLabel } from '@dotpm/ui'
import { linkedRefs } from './linkedRefs'
import { attachColumnResize, createTableColumns, FILL_TITLE_WIDTH } from './table/TableColumns'
import { attachColumnAlignment, syncTableCellAlignment } from './table/TableColumnAlignment'
import { TreeRowDrag } from './TreeRowDrag'
import { moveProjectRows, projectDropParent } from './projectHierarchy'

type ProjectColumn = 'title' | ProjectListField
const COLUMN_WIDTHS: Record<ProjectColumn, number> = {
  title: FILL_TITLE_WIDTH,
  progress: 140,
  tasks: 84,
  members: 100,
  start: 96,
  due: 88,
  completed: 96
}

export interface ProjectListContext {
  plugin: PMPlugin
  contentEl: HTMLElement
  /** The columns after the title, in order. */
  fields: ProjectListField[]
  selectedProjects: Set<string>
  openProject: (path: string, tab?: PMSettings['projectTab']) => Promise<void>
  /** Draws the list again after a row changed something about it. */
  redraw: () => void
}

/** Every project the list covers, as trees, with the rolled-up counts a parent row shows. */
export function projectListItems(plugin: PMPlugin): ProjectListItem[] {
  const { index } = plugin
  const showArchived = plugin.settings.showArchivedProjects
  const itemOf = (ref: ProjectRef): ProjectListItem => {
    const children = index.orderedProjectRefs(index.childRefs(ref.path, showArchived))
    const { total, done } = children.length ? index.rollupCounts(ref) : index.counts(ref)
    const { overdue, latestDue } = children.length ? index.rollupDueSummary(ref) : index.dueSummary(ref)
    return {
      path: ref.path,
      title: ref.title,
      folder: folderOf(projectFolderOf(plugin.app, ref.path) ?? ref.path),
      tags: ref.tags,
      done,
      total,
      overdue,
      latestDue,
      ...index.projectDates(ref),
      children: children.map(itemOf)
    }
  }
  return index.orderedProjectRefs(index.rootRefs(showArchived)).map(itemOf)
}

/** The rows, each group under a heading row that collapses it; `collapsedGroups` is edited in place. */
export function renderProjectTable(
  ctx: ProjectListContext,
  groups: ProjectListGroup[],
  groupBy: ProjectGroupBy,
  collapsedGroups: Set<string>
): void {
  const wrapper = ctx.contentEl.createDiv('pm-table-wrapper')
  wrapper.setAttr('data-borders', ctx.plugin.settings.lineBorders)
  const table = wrapper.createEl('table', { cls: 'pm-table pm-project-table' })
  const manual = ctx.plugin.settings.projectManualOrder !== false
  const columns: ProjectColumn[] = ['title', ...ctx.fields]
  const updateWidth = createTableColumns(
    table,
    [34, manual ? 54 : 32],
    columns.map((id) => ({
      id,
      defaultWidth: COLUMN_WIDTHS[id],
      width: ctx.plugin.settings.projectColumnWidths?.[id]
    })),
    40
  )
  const headRow = table.createEl('thead').createEl('tr')
  headRow.createEl('th', { cls: 'pm-table-cell-number', attr: { scope: 'col', 'aria-label': t('table.rowNumber') } })
  headRow.createEl('th')
  for (const id of columns) {
    const label = id === 'title' ? t('columns.project') : projectFieldLabel(id)
    const th = headRow.createEl('th', { text: label, cls: 'pm-table-th-resizable' })
    attachColumnAlignment(th, id, ctx.plugin, 'dashboard')
    attachColumnResize(
      th,
      table,
      id,
      (width) => updateWidth(id, width ?? ctx.plugin.settings.projectColumnWidths?.[id]),
      (width) => {
        ctx.plugin.settings.projectColumnWidths = { ...ctx.plugin.settings.projectColumnWidths, [id]: width }
        safeAsync(() => ctx.plugin.saveSettings())()
      }
    )
  }
  headRow.createEl('th')
  const tbody = table.createEl('tbody')
  const visiblePaths = [
    ...new Set(
      groups.flatMap((group) =>
        group.key !== null && collapsedGroups.has(group.key) ? [] : group.rows.map((row) => row.item.path)
      )
    )
  ]
  const drag = manual
    ? new TreeRowDrag(
        (sources, target, position) => {
          const parent = projectDropParent(ctx.plugin, sources, target, position)
          return parent === undefined
            ? null
            : {
                parent,
                parentTitle: parent ? ctx.plugin.index.projectRef(parent)?.title : undefined,
                changesParent: sources.some((path) => (ctx.plugin.index.parentOf(path)?.path ?? null) !== parent)
              }
        },
        async (sources, target, position) => {
          if (await moveProjectRows(ctx.plugin, sources, target, position, false)) ctx.redraw()
        },
        (path) => {
          if (!ctx.selectedProjects.has(path)) return [path]
          const selected = visiblePaths.filter((item) => ctx.selectedProjects.has(item))
          const roots = selected.filter(
            (item) => !ctx.plugin.index.ancestorRefs(item).some((parent) => selected.includes(parent.path))
          )
          return roots
        },
        true
      )
    : undefined
  for (const group of groups) {
    const collapsed = group.key !== null && collapsedGroups.has(group.key)
    if (group.key !== null) {
      const key = group.key
      const row = tbody.createEl('tr', { cls: 'pm-project-group-row' })
      const cell = row.createEl('td', { attr: { colspan: String(headRow.cells.length) } })
      const inner = cell.createDiv('pm-project-group')
      new CollapseToggle(inner, {
        collapsed,
        subject: groupLabel(groupBy, key),
        onToggle: () => {
          if (collapsed) collapsedGroups.delete(key)
          else collapsedGroups.add(key)
          ctx.redraw()
        }
      })
      inner.createSpan({ cls: 'pm-project-group-label', text: groupLabel(groupBy, key) })
      inner.createSpan({ cls: 'pm-project-group-count', text: String(group.count) })
    }
    if (!collapsed) for (const [index, row] of group.rows.entries()) renderRow(ctx, tbody, row, index + 1, drag)
  }
  syncTableCellAlignment(table)
}

function groupLabel(groupBy: ProjectGroupBy, key: string): string {
  if (groupBy === 'tag') return key ? `#${key}` : t('list.noTag')
  return key ? `${key}/` : t('list.noFolder')
}

function renderRow(
  ctx: ProjectListContext,
  tbody: HTMLElement,
  row: ProjectListRow,
  number: number,
  drag?: TreeRowDrag
): void {
  const { index } = ctx.plugin
  const { item } = row
  const ref = index.projectRef(item.path)
  if (!ref) return
  const { el } = new ProjectRow(tbody, {
    title: ref.title,
    icon: ref.icon,
    color: ref.color,
    depth: row.depth,
    treeGuides: ctx.plugin.settings.showSubtreeConnections ? row.guides : null,
    isLastChild: row.isLastChild,
    childCount: row.childCount,
    fields: ctx.fields,
    collapsed: row.collapsed,
    archived: index.isArchived(item.path),
    tasksDone: item.done,
    tasksTotal: item.total,
    overdue: item.overdue,
    members: linkedRefs(ctx.plugin.app, ref.teamMembers, ref.path),
    dueLabel: formatDateShort(item.latestDue),
    dueUrgency: dateUrgency(item.latestDue, item.overdue > 0),
    startLabel: formatDateLong(item.start),
    completedLabel: formatDateLong(item.completed),
    onToggleCollapsed: row.collapsible
      ? safeAsync(async () => {
          await ctx.plugin.toggleProjectCollapsed(item.path)
          ctx.redraw()
        })
      : undefined,
    onClick: safeAsync(() => ctx.openProject(item.path)),
    onContextMenu: (e) => openProjectContextMenu(ctx, ref, e),
    onActions: (e) => openProjectContextMenu(ctx, ref, e)
  })
  const numberCell = el.insertCell(0)
  numberCell.className = 'pm-table-cell-number'
  numberCell.textContent = String(number)
  if (drag) {
    drag.attach(el, item.path)
    const gutter = el.querySelector<HTMLElement>('.pm-table-cell-expand')
    const collapseToggle = gutter?.firstElementChild
    const controls = gutter?.createDiv('pm-project-row-controls')
    if (collapseToggle) controls?.appendChild(collapseToggle)
    const input = controls?.createEl('input', {
      type: 'checkbox',
      cls: 'pm-checkbox pm-project-row-select',
      attr: { 'aria-label': t('table.selectProjectForDrag') }
    })
    const paint = () => {
      const selected = ctx.selectedProjects.has(item.path)
      if (input) input.checked = selected
      el.toggleClass('pm-table-row--selected', selected)
    }
    input?.addEventListener('change', () => {
      if (input.checked) ctx.selectedProjects.add(item.path)
      else ctx.selectedProjects.delete(item.path)
      for (const row of tbody.querySelectorAll<HTMLElement>('tr[data-pm-drag-id]')) {
        if (row.dataset.pmDragId !== item.path) continue
        const checkbox = row.querySelector<HTMLInputElement>('.pm-project-row-select')
        if (checkbox) checkbox.checked = input.checked
        row.toggleClass('pm-table-row--selected', input.checked)
      }
    })
    paint()
  }
}

function openProjectContextMenu(ctx: ProjectListContext, ref: ProjectRef, e: MouseEvent): void {
  const menu = new Menu()
  menu.addItem((item) =>
    item
      .setTitle(t('project.openInCurrentTab'))
      .setIcon('arrow-right')
      .onClick(safeAsync(() => ctx.openProject(ref.path, 'current')))
  )
  menu.addItem((item) =>
    item
      .setTitle(t('project.openInNewTab'))
      .setIcon('external-link')
      .onClick(safeAsync(() => ctx.openProject(ref.path, 'new')))
  )
  menu.addSeparator()
  menu.addItem((item) =>
    item
      .setTitle(t('project.openOverview'))
      .setIcon('file-text')
      .onClick(safeAsync(() => ctx.plugin.router.openProjectOverview(ref.path)))
  )
  menu.addItem((item) =>
    item
      .setTitle(t('project.openTasks'))
      .setIcon('table')
      .onClick(safeAsync(() => ctx.plugin.router.openProjectTasks(ref.path)))
  )
  menu.addItem((item) =>
    item
      .setTitle(t('commands.duplicateProject'))
      .setIcon('copy')
      .onClick(
        safeAsync(async () => {
          const project = await ctx.plugin.store.loadProjectByPath(ref.path)
          if (!project) return
          await ctx.plugin.duplicateProjectFlow(project)
        })
      )
  )
  menu.addItem((item) =>
    item
      .setTitle(t('project.edit'))
      .setIcon('settings')
      .onClick(safeAsync(() => ctx.plugin.router.openProjectEdit(ref.path)))
  )
  if (!ctx.plugin.index.isArchived(ref.path)) {
    menu.addItem((item) =>
      item
        .setTitle(t('project.archive'))
        .setIcon('archive')
        .onClick(safeAsync(() => ctx.plugin.setProjectArchived(ref.path, true)))
    )
  } else if (ref.archived) {
    menu.addItem((item) =>
      item
        .setTitle(t('project.unarchive'))
        .setIcon('archive-restore')
        .onClick(safeAsync(() => ctx.plugin.setProjectArchived(ref.path, false)))
    )
  }
  menu.addItem((item) =>
    item
      .setTitle(t('project.delete'))
      .setIcon('trash')
      .onClick(
        safeAsync(async () => {
          const project = await ctx.plugin.store.loadProjectByPath(ref.path)
          if (!project) return
          await ctx.plugin.store.deleteProject(project)
          ctx.redraw()
        })
      )
  )
  menu.showAtMouseEvent(e)
}
