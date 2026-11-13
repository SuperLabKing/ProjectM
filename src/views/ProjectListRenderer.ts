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
import { TreeRowDrag, type TreeDrop } from './TreeRowDrag'
import { PM_PROJECT_OVERVIEW_VIEW_TYPE, ProjectOverviewView } from './ProjectOverviewView'

type ProjectColumn = 'title' | ProjectListField
const COLUMN_WIDTHS: Record<ProjectColumn, number> = {
  title: 180,
  progress: 140,
  tasks: 84,
  members: 100,
  start: 96,
  due: 88,
  completed: 96
}
const MIN_COLUMN_WIDTH = 48

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
  const colgroup = table.createEl('colgroup')
  const gutterWidth = manual ? 54 : 32
  colgroup.createEl('col').setCssStyles({ width: `${gutterWidth}px` })
  const widths = new Map<ProjectColumn, number>()
  const elements = new Map(
    columns.map((id) => {
      const col = colgroup.createEl('col')
      const saved = ctx.plugin.settings.projectColumnWidths?.[id]
      if (typeof saved === 'number' && Number.isFinite(saved) && saved >= MIN_COLUMN_WIDTH) widths.set(id, saved)
      return [id, col] as const
    })
  )
  const actionsWidth = 40
  colgroup.createEl('col', { cls: 'pm-project-col-actions' }).setCssStyles({ width: `${actionsWidth}px` })
  const updateWidths = (titleWidth = widths.get('title')): void => {
    let total = gutterWidth + actionsWidth
    for (const id of columns) {
      const width = id === 'title' ? titleWidth : (widths.get(id) ?? COLUMN_WIDTHS[id])
      elements.get(id)?.style.setProperty('width', width === undefined ? '' : `${width}px`)
      total += width ?? COLUMN_WIDTHS[id]
    }
    table.setCssStyles({ width: titleWidth === undefined ? `max(100%, ${total}px)` : `${total}px` })
  }
  updateWidths()
  const headRow = table.createEl('thead').createEl('tr')
  headRow.createEl('th')
  for (const id of columns) {
    const label = id === 'title' ? t('columns.project') : projectFieldLabel(id)
    const th = headRow.createEl('th', { text: label, cls: 'pm-table-th-resizable' })
    attachProjectColumnResize(
      th,
      table,
      (width, titleWidth) => {
        if (width === undefined) {
          const saved = ctx.plugin.settings.projectColumnWidths?.[id]
          if (saved !== undefined) widths.set(id, saved)
          else widths.delete(id)
        } else widths.set(id, width)
        updateWidths(widths.get('title') ?? titleWidth)
      },
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
          const parent = projectDropParent(ctx, sources, target, position)
          return parent === undefined
            ? null
            : {
                parent,
                parentTitle: parent ? ctx.plugin.index.projectRef(parent)?.title : undefined,
                changesParent: sources.some((path) => (ctx.plugin.index.parentOf(path)?.path ?? null) !== parent)
              }
        },
        (sources, target, position) => moveProjectRows(ctx, sources, target, position),
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
      const cell = row.createEl('td', { attr: { colspan: String(columns.length + 2) } })
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
    if (!collapsed) for (const row of group.rows) renderRow(ctx, tbody, row, drag)
  }
}

function projectDropParent(
  ctx: ProjectListContext,
  sources: string[],
  target: string,
  position: TreeDrop
): string | null | undefined {
  const { index } = ctx.plugin
  const parent = position === 'inside' ? target : (index.parentOf(target)?.path ?? null)
  const ancestors = index.ancestorRefs(target)
  if (sources.some((source) => source === target || ancestors.some((ref) => ref.path === source))) return undefined
  return parent
}

async function moveProjectRows(
  ctx: ProjectListContext,
  sources: string[],
  target: string,
  position: TreeDrop
): Promise<void> {
  const { index, settings, store } = ctx.plugin
  const parent = projectDropParent(ctx, sources, target, position)
  if (parent === undefined) return
  const projects = await Promise.all(sources.map((source) => store.loadProjectByPath(source)))
  const moving = projects.flatMap((project) => project ?? [])
  if (moving.length !== sources.length) return
  const sourcePaths = new Set(sources)
  const refs = parent ? index.childRefs(parent, true) : index.rootRefs(true)
  const siblings = index.orderedProjectRefs(refs).filter((ref) => !sourcePaths.has(ref.path))
  const targetIndex = siblings.findIndex((ref) => ref.path === target)
  const insertion = targetIndex < 0 ? siblings.length : targetIndex + Number(position === 'after')
  const ids = siblings.map((ref) => ref.id)
  if (!(await store.moveProjects(moving, parent))) return
  ids.splice(insertion, 0, ...moving.map((project) => project.id))
  const moved = new Set(ids)
  settings.projectOrder = [...ids, ...(settings.projectOrder ?? []).filter((id) => !moved.has(id))]
  if (parent) settings.collapsedProjects = settings.collapsedProjects.filter((path) => path !== parent)
  await ctx.plugin.saveSettings()
  ctx.redraw()
  for (const leaf of ctx.plugin.app.workspace.getLeavesOfType(PM_PROJECT_OVERVIEW_VIEW_TYPE)) {
    if (leaf.view instanceof ProjectOverviewView) leaf.view.render()
  }
}

function attachProjectColumnResize(
  th: HTMLTableCellElement,
  table: HTMLTableElement,
  preview: (width?: number, titleWidth?: number) => void,
  save: (width: number) => void
): void {
  const label = t('table.fitProjectColumn')
  const handle = th.createDiv({
    cls: 'pm-table-resize',
    attr: { tabindex: '0', role: 'button', 'aria-label': label, title: label }
  })
  const titleWidth = () => Math.round(table.tHead?.rows[0].cells[1].getBoundingClientRect().width ?? 0)
  const fit = () => {
    const width = fitProjectColumn(table, th)
    preview(width, titleWidth())
    save(width)
  }
  handle.addEventListener('dblclick', fit)
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    fit()
  })
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    const initial = Math.round(th.getBoundingClientRect().width)
    const fixedTitle = titleWidth()
    let width = initial
    let moved = false
    handle.setPointerCapture(event.pointerId)
    th.addClass('is-resizing')
    const listeners = new AbortController()
    const options = { capture: true, signal: listeners.signal }
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return
      width = Math.max(MIN_COLUMN_WIDTH, Math.round(initial + next.clientX - event.clientX))
      if (!moved && width === initial) return
      moved = true
      preview(width, fixedTitle)
    }
    const finish = (end: PointerEvent) => {
      if (end.pointerId !== event.pointerId) return
      listeners.abort()
      th.removeClass('is-resizing')
      if (end.type === 'pointerup' && width !== initial) save(width)
      else if (moved) preview()
    }
    const doc = handle.ownerDocument
    doc.addEventListener('pointermove', move, options)
    doc.addEventListener('pointerup', finish, options)
    doc.addEventListener('pointercancel', finish, options)
    handle.addEventListener('lostpointercapture', finish, options)
  })
}

/** Measure the actual header and shown rows at their intrinsic width, outside the sized grid. */
function fitProjectColumn(table: HTMLTableElement, th: HTMLTableCellElement): number {
  const measure = table.ownerDocument.createElement('table')
  measure.className = 'pm-table pm-project-table pm-project-table-measure'
  measure.setAttribute('aria-hidden', 'true')
  const header = measure.createTHead().insertRow()
  const heading = header.appendChild(th.cloneNode(true) as HTMLTableCellElement)
  heading.querySelector('.pm-table-resize')?.remove()
  const body = measure.createTBody()
  for (const row of table.querySelectorAll<HTMLTableRowElement>('.pm-project-row')) {
    const copy = body.appendChild(row.cloneNode(false) as HTMLTableRowElement)
    copy.appendChild(row.cells[th.cellIndex].cloneNode(true))
  }
  table.after(measure)
  const width = Math.ceil(heading.getBoundingClientRect().width) + 8
  measure.remove()
  return Math.max(MIN_COLUMN_WIDTH, width)
}

function groupLabel(groupBy: ProjectGroupBy, key: string): string {
  if (groupBy === 'tag') return key ? `#${key}` : t('list.noTag')
  return key ? `${key}/` : t('list.noFolder')
}

function renderRow(ctx: ProjectListContext, tbody: HTMLElement, row: ProjectListRow, drag?: TreeRowDrag): void {
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
      .onClick(safeAsync(() => ctx.plugin.router.openScope({ kind: 'project', path: ref.path })))
  )
  if (ctx.plugin.index.childRefs(ref.path).length) {
    menu.addItem((item) =>
      item
        .setTitle(t('project.openWithSubProjects'))
        .setIcon('layers')
        .onClick(safeAsync(() => ctx.plugin.router.openScope({ kind: 'subtree', path: ref.path })))
    )
  }
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
