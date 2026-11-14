import { Notice, type KeymapEventHandler, type Scope } from 'obsidian'
import { confirmDialog } from '#ui/ModalFactory'
import type PMPlugin from '#main'
import {
  LINKED_ROW_PREFIX,
  t,
  tn,
  type TaskQuery,
  type Project,
  type SortRule,
  type ViewFields,
  shownFields
} from '@dotpm/core'
import type { ProjectScope } from '#store'
import { safeAsync } from '@dotpm/ui'
import type { SubView } from '../SubView'
import { collapsedTaskIds } from '../collapse'
import { renderTable, refreshTableBody, handleTableKeyDown, ROW_HEIGHT_ESTIMATE } from './TableRenderer'
import type { TableState } from './TableRenderer'
import { updateSelectAllCheckbox } from './TableRow'
import { renderBulkActionBar } from './BulkActionBar'
import type { BulkAction } from './BulkActionBar'
import { groupsFor } from './ProjectTaskGroups'
import { animateTableFold } from './animateTableFold'
import { assignGroup, groupForRow, groupRoot, projectGroups, saveProjectGroups } from '#store/ProjectTaskGroups'

const TABLE_KEYS = ['Escape', 'ArrowDown', 'ArrowUp', 'j', 'k', 'Enter', 'e', 'Delete', 'Backspace']

export class TableView implements SubView {
  private state: TableState
  private pendingScrollTop: number | null = null
  private keyHandlers: KeymapEventHandler[]

  constructor(
    private container: HTMLElement,
    private scope: ProjectScope,
    private plugin: PMPlugin,
    private onRefresh: () => Promise<void>,
    query: TaskQuery,
    sort: SortRule[],
    private manualOrder: boolean,
    private onSortChange: () => void,
    private keyScope: Scope,
    private fields: ViewFields,
    private onFieldsChange: () => void
  ) {
    this.state = {
      sort,
      query,
      selectedTaskId: null,
      selectedTaskIds: new Set(),
      selectedLinkedRowIds: new Set(),
      lastCheckedTaskId: null,
      tableBody: null,
      wrapper: null,
      visibleRows: [],
      displayTaskIds: [],
      displayRowIndices: new Map(),
      windowLength: 0,
      rowHeight: ROW_HEIGHT_ESTIMATE,
      calibrating: false,
      resizeObserver: null,
      windowStart: -1,
      windowEnd: -1,
      renderWindow: null
    }
    this.keyHandlers = TABLE_KEYS.map((key) =>
      keyScope.register([], key, (e) => {
        handleTableKeyDown(e, this.makeTableContext())
      })
    )
  }

  getScrollTop(): number {
    const wrapper = this.container.querySelector('.pm-table-wrapper')
    return wrapper?.scrollTop ?? 0
  }

  animateLinkedFold(rowId: string, collapsed: boolean, render: () => void): Promise<void> {
    return animateTableFold(this.state.wrapper, this.state.tableBody, rowId, collapsed, render)
  }

  linkedNoteGroupOptions(recordId?: string) {
    const project = this.scope.spec.kind === 'project' ? this.scope.primary : null
    if (!project) return null
    const rowId = recordId ? LINKED_ROW_PREFIX + recordId : undefined
    const group = rowId ? groupForRow(this.plugin, project, rowId) : undefined
    return {
      currentId: group?.id ?? null,
      inherited: !!rowId && groupRoot(project, rowId) !== rowId,
      groups: projectGroups(this.plugin, project).map(({ id, name }) => ({ id, name }))
    }
  }

  async setLinkedNoteGroup(recordId: string, groupId: string | null): Promise<void> {
    const project = this.scope.spec.kind === 'project' ? this.scope.primary : null
    const rowId = LINKED_ROW_PREFIX + recordId
    if (!project || groupRoot(project, rowId) !== rowId) return
    if ((groupForRow(this.plugin, project, rowId)?.id ?? null) === groupId) return
    await saveProjectGroups(this.plugin, project, (groups) => {
      if (groupId && !groups.some((group) => group.id === groupId)) {
        throw new Error(t('taskGroups.missing'))
      }
      return assignGroup(groups, new Set([rowId]), groupId)
    })
    await this.onRefresh()
    this.plugin.refreshViews()
  }

  setPendingScrollTop(top: number): void {
    this.pendingScrollTop = top
  }

  setManualOrder(enabled: boolean): void {
    this.manualOrder = enabled
    if (!enabled) this.state.selectedLinkedRowIds.clear()
    this.setPendingScrollTop(this.getScrollTop())
    this.render()
  }

  render(): void {
    this.state.tableBody = null
    this.state.renderLinkedRow = undefined
    this.container.empty()
    this.container.addClass('pm-table-view')

    const ctx = this.makeTableContext()
    renderTable(ctx)
    renderBulkActionBar({ ctx, onAction: safeAsync((a) => this.handleBulkAction(a)) })

    if (this.pendingScrollTop !== null) {
      const wrapper = this.container.querySelector('.pm-table-wrapper')
      if (wrapper) {
        wrapper.scrollTop = this.pendingScrollTop
        // Synchronously, rather than waiting on the scroll event's animation frame.
        this.state.renderWindow?.()
      }
      this.pendingScrollTop = null
    }
  }

  destroy(): void {
    for (const handler of this.keyHandlers) this.keyScope.unregister(handler)
    this.keyHandlers = []
    this.state.resizeObserver?.disconnect()
    this.state.resizeObserver = null
  }

  refresh(): void {
    this.doRefreshTable()
    this.updateBulkBar()
  }

  private doRefreshTable(): void {
    const ctx = this.makeTableContext()
    if (this.state.tableBody && !!this.state.rowDrag === (this.manualOrder || groupsFor(ctx).length > 0)) {
      refreshTableBody(ctx)
    } else {
      this.setPendingScrollTop(this.getScrollTop())
      this.render()
    }
  }

  async handleBulkAction(action: BulkAction): Promise<void> {
    const ids = [...this.state.selectedTaskIds]
    if (!ids.length) return

    // A selection can span projects, and every mutator takes one. Each project's share
    // of the selection goes in its own call, so each still saves once.
    const groups = this.scope.groupByProject(ids)
    try {
      if (action.type === 'delete') {
        if (!(await confirmDialog(this.plugin.app, tn('table.deleteTasksConfirm', ids.length)))) {
          return
        }
      }
      for (const { project, taskIds } of groups) {
        await this.applyBulkAction(action, project, taskIds)
      }
      switch (action.type) {
        case 'set-parent':
          new Notice(tn('table.movedTasksUnderParent', ids.length))
          break
        case 'remove-parent':
          new Notice(tn('table.movedTasksToTopLevel', ids.length))
          break
        case 'archive':
          new Notice(tn('table.archivedTasks', ids.length))
          break
        case 'unarchive':
          new Notice(tn('table.unarchivedTasks', ids.length))
          break
      }
      this.state.selectedTaskIds.clear()
      await this.onRefresh()
    } catch (err) {
      console.error('Bulk action failed', err)
      new Notice(t('bulk.failed'))
      await this.onRefresh()
    }
  }

  private async applyBulkAction(action: BulkAction, project: Project, ids: string[]): Promise<void> {
    switch (action.type) {
      case 'set-status':
        await this.plugin.store.updateTasks(project, ids, { status: action.status })
        break
      case 'set-priority':
        await this.plugin.store.updateTasks(project, ids, { priority: action.priority })
        break
      case 'set-assignee':
        if (action.assignee === '') {
          await this.plugin.store.updateTasks(project, ids, { assignees: [] })
        } else {
          await this.bulkAddToArray(project, ids, 'assignees', action.assignee)
        }
        break
      case 'set-tag':
        if (action.tag === '') {
          await this.plugin.store.updateTasks(project, ids, { tags: [] })
        } else {
          await this.bulkAddToArray(project, ids, 'tags', action.tag)
        }
        break
      case 'set-due-date':
        await this.plugin.store.updateTasks(project, ids, { due: action.due })
        for (const id of ids) {
          await this.plugin.store.scheduleAfterChange(project, id)
        }
        break
      case 'set-progress':
        await this.plugin.store.updateTasks(project, ids, { progress: action.progress })
        break
      case 'set-parent':
        await this.plugin.store.moveTasks(project, ids, action.parentId)
        break
      case 'remove-parent':
        await this.plugin.store.moveTasks(project, ids, null)
        break
      case 'archive':
        for (const id of ids) {
          await this.plugin.store.archiveTask(project, id)
        }
        break
      case 'unarchive':
        for (const id of ids) {
          await this.plugin.store.unarchiveTask(project, id)
        }
        break
      case 'delete':
        await this.plugin.store.deleteTasks(project, ids)
        break
    }
  }

  private async bulkAddToArray(
    project: Project,
    ids: string[],
    field: 'assignees' | 'tags',
    value: string
  ): Promise<void> {
    await this.plugin.store.updateTasks(project, ids, (task) =>
      task[field].includes(value) ? null : { [field]: [...task[field], value] }
    )
  }

  private updateBulkBar(): void {
    const ctx = this.makeTableContext()
    renderBulkActionBar({ ctx, onAction: safeAsync((a) => this.handleBulkAction(a)) })
  }

  private makeTableContext() {
    const config = this.scope.config
    return {
      container: this.container,
      scope: this.scope,
      plugin: this.plugin,
      statuses: config.statuses,
      priorities: config.priorities,
      priorityIcons: config.priorityIcons,
      showSubtreeConnections: config.showSubtreeConnections,
      lineBorders: config.lineBorders,
      collapsedIds: collapsedTaskIds(this.plugin.settings, this.scope.projects),
      columns: shownFields(this.fields, 'table', this.scope.fieldCatalog()),
      manualOrder: this.manualOrder,
      fields: this.fields,
      state: this.state,
      onRefresh: this.onRefresh,
      onSelectionChange: () => {
        updateSelectAllCheckbox(this.state)
        this.updateBulkBar()
      },
      onBulkDelete: safeAsync(() => this.handleBulkAction({ type: 'delete' })),
      onSortChange: this.onSortChange,
      onFieldsChange: this.onFieldsChange
    }
  }
}
