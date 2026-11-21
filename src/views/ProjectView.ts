import { ItemView, Menu, Platform, Scope, setIcon, WorkspaceLeaf } from 'obsidian'
import type PMPlugin from '#main'
import { addTabPageItems, refreshTabTitle } from '#ui/tab'
import {
  type GanttGranularity,
  type NonWorkingDays,
  type Project,
  type SavedView,
  type ResolvedProjectConfig,
  type SortRule,
  type GroupState,
  type TaskQuery,
  type ViewFields,
  type ViewMode,
  flattenTasks,
  shownFields,
  withDefault,
  tidyFields,
  GANTT_GRANULARITIES,
  bestConditionToDrop,
  countActiveFilters,
  filterFieldLabel,
  isQueryActive,
  makeDefaultFilter,
  makeDefaultGroup,
  makeDefaultSort,
  sameValue,
  viewDifferences,
  makeId,
  matchesQuery,
  t,
  tn
} from '@dotpm/core'
import {
  folderOf,
  personKeyer,
  ProjectScope,
  projectFolderOf,
  type ProjectRef,
  resolveScopePaths,
  scopeKey,
  type ScopeSpec
} from '#store'
import {
  boardCandidates,
  boardColumns,
  boardField,
  ChipButton,
  IconButton,
  clampZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  openNonWorkingDaysPopover,
  Stepper,
  stepZoom,
  EmptyState,
  groupableFields,
  openFieldsPopover,
  openGroupPopover,
  type BoardColumn,
  FilterBar,
  openProjectSwitcher,
  openSavedViewsPopover,
  openSearchPopover,
  openSortPopover,
  renderFieldsPanel,
  renderFilterPanel,
  renderGroupPanel,
  renderGlyph,
  renderSortPanel,
  renderBreadcrumb,
  safeAsync,
  SearchBox,
  showMenuBelow,
  SplitButton,
  ViewHeader,
  type FieldsPopoverProps,
  type FilterSetup,
  type GroupPopoverProps,
  type PlatformMenu,
  type SearchBoxProps,
  type SheetTab,
  type SortPopoverProps,
  type TuneSheetProps,
  type SortField,
  type StepperProps,
  type SwitcherProject,
  type TuneItem,
  SavedViewSlot,
  summarizeSort,
  syncSortButton,
  type SortSummary
} from '@dotpm/ui'
import type { SubView } from './SubView'
import { TableView } from './table/TableView'
import type { ExportViewState } from '../export/snapshot'
import { GanttView } from './gantt/GanttView'
import { KanbanView } from './KanbanView'
import { openTaskModal } from '#ui/ModalFactory'
import { TaskDetailPanel } from './TaskDetailPanel'
import { exportViewAsHtml } from '../export/exportView'
import { collapsedTaskIds, setAllCollapsed } from './collapse'
import { moveProjectRows, projectDropParent } from './projectHierarchy'
import type { TreeDrop } from './TreeRowDrag'

export const PM_PROJECT_VIEW_TYPE = 'pm-project'

interface ProjectViewState {
  scope?: ScopeSpec
  /** How a project view was addressed before scopes; still accepted from saved layouts. */
  filePath?: string
  anchor?: string
  [key: string]: unknown
}

const MODES: ViewMode[] = ['table', 'gantt', 'kanban']
const PROJECT_TREE_WIDTH = { min: 152, initial: 210, max: 520 }

interface ProjectTreePreferences {
  visible?: boolean
  width?: number
  branches?: Record<string, boolean>
}
const MODE_ICONS: Record<ViewMode, string> = { table: 'table', gantt: 'chart-gantt', kanban: 'kanban' }
const SCOPE_ICONS = { picked: 'layers', folder: 'folder', vault: 'vault' }
const modeLabel = (mode: ViewMode): string =>
  ({ table: t('views.table'), gantt: t('views.gantt'), kanban: t('views.kanban') })[mode]
const granularityLabel = (granularity: GanttGranularity): string => t(`granularity.${granularity}`)

function ends(list: { label: string }[]): [string, string] | undefined {
  return list.length ? [list[0].label, list[list.length - 1].label] : undefined
}

const sortFields = (config?: ResolvedProjectConfig): SortField[] => [
  { id: 'title', label: t('columns.task') },
  { id: 'status', label: t('columns.status'), ends: config && ends(config.statuses) },
  { id: 'priority', label: t('columns.priority'), ends: config && ends(config.priorities) },
  { id: 'assignees', label: t('columns.assignees') },
  { id: 'due', label: t('columns.due') },
  { id: 'progress', label: t('columns.progress') }
]

/** One of a mode's own controls, as the options slot, the Tune list and the More menu draw it. */
interface ViewOption {
  id: 'today' | 'scale' | 'days' | 'collapse'
  icon: string
  label: string
  /** The current value: the Tune list's faint state, and the chip's text when `chip` is `value`. */
  value?: string
  /** How the options slot draws it: icon and label, the value with a chevron, or the icon alone. */
  chip: 'label' | 'value' | 'icon'
  run: (anchor: HTMLElement) => void
}

function specOf(state: ProjectViewState): ScopeSpec | null {
  if (state.scope?.kind === 'subtree') return { kind: 'project', path: state.scope.path }
  if (state.scope) return state.scope
  if (state.filePath) return { kind: 'project', path: state.filePath }
  return null
}

export class ProjectView extends ItemView {
  plugin: PMPlugin
  projectScope: ProjectScope | null = null
  private spec: ScopeSpec | null = null
  /** The project last shown on its own, which "This project" returns to from a wider scope. */
  private anchorPath: string | null = null
  currentView: ViewMode
  /** The saved filter plus the search text, which lives only as long as this view. */
  query: TaskQuery = { filter: makeDefaultFilter(), text: '' }
  activeSavedViewId: string | null = null
  sort: SortRule[] = makeDefaultSort()
  private tableManualOrder = true
  group: GroupState = makeDefaultGroup()
  fields: ViewFields = {}
  nonWorkingDays: NonWorkingDays = {}
  /** Percent of the scale's day width. Kept per device, not in the view. */
  zoom = 100
  granularity: GanttGranularity
  private subview: SubView | null = null
  private headerEl!: HTMLElement
  private projectTreeEl!: HTMLElement
  private projectTreeResize!: HTMLElement
  private projectTreeToggle: HTMLElement | null = null
  private projectTreeOpen = !Platform.isPhone
  private projectTreeKey: string | undefined
  private taskDetails?: TaskDetailPanel
  private bodyEl!: HTMLElement
  private emptyEl!: HTMLElement
  private header: ViewHeader | null = null
  private filterBar: FilterBar | null = null
  private searchBox: SearchBox | null = null
  private queryBarOpen = false
  private viewSlot: SavedViewSlot | null = null
  private filterButton: ChipButton | null = null
  private sortButton: ChipButton | null = null
  private groupButton: ChipButton | null = null
  private fieldsButton: ChipButton | null = null
  private zoomStepper: Stepper | null = null
  private daysButton: ChipButton | null = null
  private keyScope: Scope
  private pendingRefresh: Promise<void> | null = null
  private initialized = false
  /** Set once the default view mode is applied, so reloads don't undo a mode switch. */
  private defaultViewAppliedFor: string | null = null
  /**
   * The paths the current load covers, claimed before it starts. Loading a project can
   * write to it, and that write comes back as an index change, so comparing against the
   * projects already in hand would reload on top of a load that has not finished.
   */
  private loadedPaths: string[] = []

  constructor(leaf: WorkspaceLeaf, plugin: PMPlugin) {
    super(leaf)
    this.plugin = plugin
    this.currentView = plugin.settings.defaultView
    this.granularity = plugin.settings.ganttGranularity
    this.navigation = false
    this.keyScope = new Scope(this.app.scope)
    this.scope = this.keyScope
    this.keyScope.register(['Mod'], 's', () => {
      if (!this.viewChanges().length) return true
      safeAsync(() => this.updateActiveView())()
      return false
    })
  }

  getViewType(): string {
    return PM_PROJECT_VIEW_TYPE
  }
  getDisplayText(): string {
    return this.projectScope?.label() ?? t('common.project')
  }

  /** The mode, filter, sort and scale a reader of an export starts from. */
  exportState(): ExportViewState {
    return {
      mode: this.currentView,
      filter: structuredClone(this.query.filter),
      sort: this.currentView === 'table' && this.tableManualOrder ? [] : structuredClone(this.sort),
      group: structuredClone(this.group),
      fields: structuredClone(this.fields),
      ganttGranularity: this.granularity,
      nonWorkingDays: structuredClone(this.nonWorkingDays)
    }
  }
  getIcon(): string {
    return 'chart-gantt'
  }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source)
    const scope = this.projectScope
    const primary = scope?.primary
    if (!scope || !primary) return
    if (!scope.isMulti) addTabPageItems(menu, this.plugin, this.leaf, primary.filePath, ['note', 'edit'])
    menu.addItem((item) =>
      item
        .setSection('action')
        .setTitle(t('commands.exportViewHtml'))
        .setIcon('file-output')
        .onClick(
          safeAsync(async () => {
            await exportViewAsHtml(this.plugin, this)
          })
        )
    )
  }

  /** The project a command should act on: the only one, or the group's primary. */
  get project(): Project | null {
    return this.projectScope?.primary ?? null
  }

  async setState(state: ProjectViewState, result: unknown): Promise<void> {
    const spec = specOf(state)
    if (typeof state.anchor === 'string') this.anchorPath = state.anchor
    if (spec && (!this.spec || scopeKey(this.spec) !== scopeKey(spec))) {
      this.spec = spec
      await this.loadScope()
    }
    await super.setState(state, result as import('obsidian').ViewStateResult)
  }

  getState(): ProjectViewState {
    return {
      scope: this.spec ?? undefined,
      filePath: this.projectScope?.primary?.filePath,
      anchor: this.anchorPath ?? undefined
    }
  }

  onOpen(): Promise<void> {
    // Setup only. setState is the sole loader; this just guarantees the scaffold and
    // listeners exist for hosts that open the view without it.
    this.ensureInitialized()
    return Promise.resolve()
  }

  async onClose(): Promise<void> {
    await this.taskDetails?.close()
    this.subview?.destroy?.()
    this.subview = null
    this.header?.destroy()
    this.header = null
    return Promise.resolve()
  }

  // Pane Relief and Hover Editor restore a deferred leaf via setState without ever
  // calling onOpen, so the one-time setup runs from whichever fires first.
  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true

    this.containerEl.addClass('pm-view')
    const root = this.contentEl
    root.empty()
    root.addClass('pm-root')
    this.headerEl = root.createDiv('pm-vh-mount')
    const layout = root.createDiv('pm-project-task-layout').createDiv('pm-project-task-split')
    this.projectTreeEl = layout.createEl('nav', {
      cls: 'pm-project-tree',
      attr: { 'aria-label': t('header.projectTree') }
    })
    this.projectTreeEl.hidden = true
    const treeWindow = this.projectTreeEl.ownerDocument.defaultView
    if (treeWindow) {
      const syncGuidePixel = () =>
        this.projectTreeEl.style.setProperty('--pm-project-tree-device-pixel', `${1 / treeWindow.devicePixelRatio}px`)
      syncGuidePixel()
      this.registerDomEvent(treeWindow, 'resize', syncGuidePixel)
    }
    this.attachProjectTreeResize(layout)
    const content = layout.createDiv('pm-project-task-main')
    this.bodyEl = content.createDiv('pm-content')
    this.emptyEl = content.createDiv('pm-filter-empty pm-hidden')
    this.taskDetails = new TaskDetailPanel(layout, this.plugin, this.keyScope)

    this.register(
      this.plugin.store.onProjectChanged((path) => {
        if (this.scopeDependsOn(path)) this.redraw()
      })
    )
    this.register(this.plugin.index.onNoteColorChange(() => this.redraw()))
    // A scope changes when a project joins or leaves it, which for a single-project scope
    // includes the project appearing once the index has caught up with the vault.
    this.register(
      this.plugin.index.onChange(() => {
        if (!this.spec) return
        const paths = resolveScopePaths(this.spec, this.plugin.index)
        const current = this.loadedPaths
        if (paths.length !== current.length || paths.some((path, i) => path !== current[i])) {
          void this.loadScope()
        } else {
          this.renderProjectTree()
        }
      })
    )
  }

  private scopeDependsOn(path: string): boolean {
    const projects = this.projectScope?.projects
    if (!projects) return false
    return projects.some(
      (project) =>
        project.filePath === path || this.plugin.index.ancestorRefs(project.filePath).some((ref) => ref.path === path)
    )
  }

  /**
   * Something outside the DOM changed: a project in scope, or a setting that decides how
   * it is drawn. The store keeps one instance per file, so the projects are already
   * current and only the DOM needs catching up.
   */
  redraw(): void {
    if (!this.projectScope || !this.spec) return
    if (!this.projectScope.primary) {
      this.renderEmptyScope()
      return
    }
    // A settings edit may have changed a palette, which the scope has resolved and kept.
    this.projectScope.invalidate()
    refreshTabTitle(this.leaf)
    this.renderProjectTree()
    // Rebuilding the header would drop the caret out of the search box.
    if (this.headerEl.contains(activeDocument.activeElement)) this.syncHeader()
    else this.renderHeader()
    void this.refreshProject()
  }

  private async loadScope(): Promise<void> {
    this.ensureInitialized()
    const spec = this.spec
    if (!spec) return
    await this.taskDetails?.close()
    if (this.spec !== spec) return
    if (spec.kind === 'project') this.anchorPath = spec.path
    const paths = resolveScopePaths(spec, this.plugin.index)
    this.loadedPaths = paths
    const projects = await this.plugin.store.loadProjects(paths)
    if (this.spec !== spec) return
    this.projectScope = new ProjectScope(spec, projects, this.plugin.store)
    if (!this.projectScope.primary) {
      this.renderEmptyScope()
      return
    }
    if (this.defaultViewAppliedFor !== this.projectScope.key) {
      this.defaultViewAppliedFor = this.projectScope.key
      this.currentView = this.projectScope.config.defaultView
    }
    this.loadFilterFromSettings()
    this.zoom = clampZoom(Number(this.app.loadLocalStorage(this.zoomKey())) || 100)
    this.queryBarOpen = countActiveFilters(this.query.filter) > 0
    refreshTabTitle(this.leaf)
    this.renderProjectTree()
    this.renderHeader()
    this.renderCurrentView()
  }

  private async switchScope(spec: ScopeSpec): Promise<void> {
    this.spec = spec
    await this.loadScope()
    if (this.spec === spec) await this.leaf.setViewState({ type: PM_PROJECT_VIEW_TYPE, state: this.getState() })
  }

  /** Moves this leaf to another scope in the same mode, or opens it in a new tab. */
  private async goTo(spec: ScopeSpec, newTab: boolean): Promise<void> {
    if (newTab) {
      await this.plugin.router.openScope(spec)
      return
    }
    this.defaultViewAppliedFor = scopeKey(spec)
    await this.switchScope(spec)
  }

  private loadFilterFromSettings(): void {
    const saved = this.projectScope ? this.plugin.settings.projectFilters[this.projectScope.key] : undefined
    this.tableManualOrder = saved?.tableManualOrder !== false
    if (saved) {
      this.query.filter = saved.filter
      this.activeSavedViewId = saved.activeSavedViewId
      this.sort = saved.sort
      this.group = saved.group
      this.fields = saved.fields
      this.granularity = saved.ganttGranularity
      this.nonWorkingDays = saved.nonWorkingDays
      return
    }
    this.query.filter = makeDefaultFilter()
    this.activeSavedViewId = null
    this.sort = makeDefaultSort()
    this.group = makeDefaultGroup()
    this.fields = structuredClone(this.plugin.settings.defaultFields)
    this.nonWorkingDays = {}
    this.granularity = this.plugin.settings.ganttGranularity
    // A scope seen for the first time opens with its starred view, and keeps it from then on.
    const starred = this.savedViews().find((view) => view.isDefault)
    if (starred) {
      this.applySavedView(starred)
      void this.persistFilter()
    }
  }

  private applySavedView(view: SavedView): void {
    this.query.filter = structuredClone(view.filter)
    this.activeSavedViewId = view.id
    this.sort = structuredClone(view.sort)
    if (view.group) this.group = structuredClone(view.group)
    if (view.fields) this.fields = structuredClone(view.fields)
    if (view.ganttGranularity) this.granularity = view.ganttGranularity
    if (view.nonWorkingDays) this.nonWorkingDays = structuredClone(view.nonWorkingDays)
    if (view.viewMode) this.currentView = view.viewMode
  }

  private activeView(): SavedView | undefined {
    return this.savedViews().find((view) => view.id === this.activeSavedViewId)
  }

  /** What differs from the active saved view, as the reader would name it. */
  private viewChanges(): string[] {
    const active = this.activeView()
    if (!active) return []
    const labels = {
      filter: t('header.changedFilter'),
      sort: t('header.changedSort'),
      group: t('header.changedGroup'),
      fields: t('header.changedFields'),
      mode: t('header.mode'),
      scale: t('header.scale'),
      days: t('header.changedDays')
    }
    const state = {
      filter: this.query.filter,
      sort: this.sort,
      group: this.group,
      fields: this.fields,
      mode: this.currentView,
      granularity: this.granularity,
      nonWorkingDays: this.nonWorkingDays
    }
    return viewDifferences(active, state).map((part) => labels[part])
  }

  private async persistFilter(): Promise<void> {
    if (!this.projectScope) return
    this.plugin.settings.projectFilters[this.projectScope.key] = {
      filter: this.query.filter,
      activeSavedViewId: this.activeSavedViewId,
      sort: this.sort,
      tableManualOrder: this.tableManualOrder,
      group: this.group,
      fields: this.fields,
      ganttGranularity: this.granularity,
      nonWorkingDays: this.nonWorkingDays
    }
    await this.plugin.saveSettings()
  }

  /** One project owns its saved views; a group of them has no file to keep them in. */
  private savedViews(): SavedView[] {
    if (!this.projectScope) return []
    if (this.projectScope.spec.kind === 'project') return this.projectScope.primary?.savedViews ?? []
    return this.plugin.settings.scopeViews[this.projectScope.key] ?? []
  }

  private async persistSavedViews(views: SavedView[]): Promise<void> {
    if (!this.projectScope) return
    const primary = this.projectScope.primary
    if (this.projectScope.spec.kind === 'project' && primary) {
      primary.savedViews = views
      await this.plugin.store.saveProject(primary)
      return
    }
    this.plugin.settings.scopeViews[this.projectScope.key] = views
    await this.plugin.saveSettings()
  }

  private renderEmptyScope(): void {
    this.projectTreeKey = undefined
    this.projectTreeEl.empty()
    delete this.projectTreeEl.dataset.projectTreeView
    this.syncProjectTree()
    this.header?.destroy()
    this.header = null
    this.filterBar = null
    this.headerEl.empty()
    this.bodyEl.empty()
    this.bodyEl.removeClass('pm-hidden')
    this.emptyEl.addClass('pm-hidden')
    const msg = this.bodyEl.createDiv('pm-empty-state')
    msg.createEl('h3', { text: t('projectView.nothingToShow') })
    msg.createEl('p', { text: t('projectView.missing') })
  }

  private renderHeader(): void {
    const scope = this.projectScope
    const primary = scope?.primary
    if (!scope || !primary) return
    this.header?.destroy()
    this.projectTreeToggle = null
    const header = new ViewHeader(this.headerEl)
    this.header = header
    this.renderContextSlot(header.context, scope, primary)
    this.renderViewSlot(header.view)
    this.renderQuerySlot(header.query)
    this.renderOptionsSlot(header.options, scope)
    this.renderActionsSlot(header.actions)
    header
      .setTuneItems(() => this.tuneItems())
      .setTuneSheet(() => this.tuneSheet())
      .setMoreMenu((menu, anchor) => this.fillMoreMenu(menu, anchor))
    this.renderFilterBar()
    this.syncHeader()
  }

  /** Brings the parts that follow the filter, sort and task counts up to date without rebuilding them. */
  private syncHeader(): void {
    const active = this.activeView()
    const counts = this.taskCounts()
    this.viewSlot?.sync({
      name: active?.name ?? t('header.allTasks'),
      saved: !!active,
      dirty: this.viewChanges().length > 0,
      count: this.countLabel(counts)
    })
    this.filterBar?.setSummary(t('header.shownSummary', { shown: counts.shown, total: counts.total }))
    this.syncFilterEmpty(counts)
    const filters = countActiveFilters(this.query.filter)
    this.filterButton?.setBadge(filters).setActive(filters > 0)
    this.searchBox?.setValue(this.query.text)
    this.header?.tune.setBadge(filters).setActive(isQueryActive(this.query))
    if (this.groupButton) {
      const label = this.groupSummary()
      const hidden = this.boardColumnsNow().filter((column) => column.hidden).length
      this.groupButton
        .setLabel(label || t('header.group'))
        .setDetail(hidden ? tn('header.hiddenCount', hidden) : '')
        .setActive(!!label)
    }
    if (this.fieldsButton) {
      const hidden = this.hiddenFieldCount()
      this.fieldsButton
        .setDetail(hidden ? tn('header.hiddenCount', hidden) : '')
        .setActive(this.fields[this.currentView] !== undefined)
    }
    this.zoomStepper?.setValue(`${this.zoom}%`, this.zoom <= MIN_ZOOM, this.zoom >= MAX_ZOOM)
    this.daysButton?.setActive(!!this.nonWorkingDays.weekends || !!this.nonWorkingDays.holidays)
    if (this.sortButton) {
      const manual = this.currentView === 'table' && this.tableManualOrder
      syncSortButton(this.sortButton, manual ? undefined : this.sortSummary())
      this.sortButton.setDetail(manual ? t('header.manualOrder') : '')
    }
    this.header?.fit()
  }

  /** Replaces a body the filter has emptied with a way back: the one condition that frees the most tasks. */
  private syncFilterEmpty(counts: { shown: number; total: number }): void {
    const scope = this.projectScope
    const emptied = !!scope && isQueryActive(this.query) && counts.shown === 0 && counts.total > 0
    this.emptyEl.empty()
    this.emptyEl.toggleClass('pm-hidden', !emptied)
    this.bodyEl.toggleClass('pm-hidden', emptied)
    if (!scope || !emptied) return
    const state = new EmptyState(this.emptyEl).setIcon('search-x')
    const { conditions } = this.query.filter
    if (!conditions.length) {
      state.setTitle(t('filter.noSearchMatch', { text: this.query.text.trim() }))
      return
    }
    const ctx = scope.filterContext(personKeyer(this.plugin.app))
    const tasks = flattenTasks(scope.tasks()).map((flat) => flat.task)
    const best = bestConditionToDrop(tasks, this.query, ctx)
    const apply = (): void => {
      this.handleFilterMutation()
      this.renderFilterBar()
    }
    state.setTitle(t('filter.emptyTitle'))
    if (best) {
      const label = filterFieldLabel(conditions[best.index].field, ctx.customFields)
      state
        .setBody(tn('filter.emptySuggest', best.shown, { label }))
        .setAction(t('filter.removeNamed', { label }), () => {
          conditions.splice(best.index, 1)
          apply()
        })
    } else {
      state.setBody(t('filter.emptyNone'))
    }
    state.addSecondaryAction(t('filter.clearAllFilters'), () => {
      this.query.filter.conditions = []
      apply()
    })
  }

  /** The tasks shown, and how many projects they come from when there are several. */
  private countLabel(counts: { shown: number; total: number }): string {
    const tasks = isQueryActive(this.query)
      ? t('header.shownOf', { shown: counts.shown, total: counts.total })
      : tn('header.taskCount', counts.total)
    const scope = this.projectScope
    if (!scope?.isMulti) return tasks
    return t('header.scopeCount', { projects: tn('scope.projectCount', scope.projects.length), tasks })
  }

  private taskCounts(): { shown: number; total: number } {
    const scope = this.projectScope
    if (!scope) return { shown: 0, total: 0 }
    const ctx = scope.filterContext(personKeyer(this.plugin.app))
    const all = flattenTasks(scope.tasks())
    const total = all.filter((flat) => this.query.filter.showArchived || !flat.task.archived).length
    const shown = all.filter((flat) => matchesQuery(flat.task, this.query, ctx)).length
    return { shown, total }
  }

  private renderContextSlot(parent: HTMLElement, scope: ProjectScope, primary: Project): void {
    const kind = scope.spec.kind
    const count = scope.projects.length
    const common = {
      onSwitch: (anchor: HTMLElement) => this.openSwitcher(anchor, scope, primary),
      switchLabel: t('header.switchProject'),
      foldLabel: t('header.parentProjects'),
      mode: {
        icon: MODE_ICONS[this.currentView],
        label: modeLabel(this.currentView),
        tooltip: t('header.viewMode', { mode: modeLabel(this.currentView) }),
        onOpen: (anchor: HTMLElement) => this.showModeMenu(anchor, scope, primary)
      }
    }
    if (kind === 'project' || kind === 'subtree') {
      new IconButton(parent)
        .setIcon('arrow-left')
        .setTooltip(t('project.backToDashboard'))
        .onClick(safeAsync(() => this.plugin.router.openDashboard(this.leaf)))
      const treeToggle = new IconButton(parent)
        .setIcon('panel-left')
        .setTooltip(t('header.projectTree'))
        .onClick(() => {
          this.projectTreeOpen = !this.projectTreeOpen
          this.saveProjectTreePreferences({ visible: this.projectTreeOpen })
          this.syncProjectTree()
        })
      this.projectTreeToggle = treeToggle.el
      this.syncProjectTree()
      renderBreadcrumb(parent, {
        ...common,
        icon: primary.icon,
        color: primary.color,
        ancestors: this.plugin.index.ancestorRefs(primary.filePath).map((ref) => ({
          title: ref.title,
          onOpen: safeAsync((newTab: boolean) => this.goTo(this.plugin.router.projectTaskScope(ref.path), newTab))
        })),
        title: primary.title
      })
      return
    }
    const named = kind === 'picked' ? scope.projects.slice(0, 2) : []
    let title = t('scope.all')
    if (kind === 'picked') title = named.map((project) => project.title).join(', ')
    else if (scope.spec.kind === 'folder') title = scope.spec.path || t('scope.vault')
    renderBreadcrumb(parent, {
      ...common,
      icon: SCOPE_ICONS[kind],
      ancestors: [],
      title,
      badge: kind === 'picked' && count > named.length ? `+${count - named.length}` : undefined,
      scoped: true
    })
  }

  private showModeMenu(anchor: HTMLElement, scope: ProjectScope, primary: Project): void {
    const menu = new Menu()
    this.addModeItems(menu, scope, primary)
    showMenuBelow(menu, anchor)
  }

  /** The three modes with the current one checked, then the project's overview when there is one project. */
  private addModeItems(menu: PlatformMenu, scope: ProjectScope, primary: Project): void {
    for (const mode of MODES) {
      menu.addItem((item) =>
        item
          .setTitle(modeLabel(mode))
          .setIcon(MODE_ICONS[mode])
          .setChecked(mode === this.currentView)
          .onClick(() => this.switchMode(mode))
      )
    }
    if (scope.isMulti) return
    menu.addSeparator()
    menu.addItem((item) =>
      item
        .setTitle(t('views.overview'))
        .setIcon('file-text')
        .onClick(safeAsync(() => this.plugin.router.openProjectOverview(primary.filePath, this.leaf)))
    )
  }

  private switchMode(mode: ViewMode): void {
    if (mode === this.currentView) return
    this.currentView = mode
    this.renderHeader()
    this.renderCurrentView()
  }

  private openSwitcher(anchor: HTMLElement, scope: ProjectScope, primary: Project): void {
    const index = this.plugin.index
    const spec = scope.spec
    const projects: SwitcherProject[] = []
    const add = (ref: ProjectRef, parent: string | undefined, folder: string): void => {
      projects.push({
        path: ref.path,
        title: ref.title,
        icon: ref.icon,
        color: ref.color,
        parent,
        folder,
        taskCount: index.counts(ref).total
      })
      for (const child of index.childRefs(ref.path)) add(child, ref.path, folder)
    }
    const roots = index.rootRefs().map((ref) => ({ ref, folder: this.containingFolder(ref.path) }))
    roots.sort((a, b) => a.folder.localeCompare(b.folder))
    for (const { ref, folder } of roots) add(ref, undefined, folder)

    const anchorProject = scope.projects.find((project) => project.filePath === this.anchorPath) ?? primary
    const path = spec.kind === 'project' ? spec.path : anchorProject.filePath
    const pick = safeAsync((picked: string) => this.goTo(this.plugin.router.projectTaskScope(picked), false))
    openProjectSwitcher(anchor, {
      projects,
      selected: scope.projects.map((project) => project.filePath),
      current: spec.kind === 'project' ? spec.path : undefined,
      presets:
        spec.kind === 'project'
          ? []
          : [
              {
                label: t('scope.only', { title: index.projectRef(path)?.title ?? anchorProject.title }),
                active: false,
                onPick: () => pick(path)
              }
            ],
      onScopeCheck: pick,
      onPick: pick
    })
  }

  private syncProjectTree(): void {
    this.projectTreeEl.hidden = !this.projectTreeOpen || !this.projectTreeEl.childElementCount
    this.projectTreeResize.hidden = this.projectTreeEl.hidden
    this.projectTreeToggle?.setAttribute('aria-expanded', String(!this.projectTreeEl.hidden))
  }

  private projectTreePreferences(key = this.projectTreeKey): ProjectTreePreferences {
    return key ? ((this.app.loadLocalStorage(key) as ProjectTreePreferences | null) ?? {}) : {}
  }

  private saveProjectTreePreferences(changes: ProjectTreePreferences, key = this.projectTreeKey): void {
    if (key) {
      const saved = this.projectTreePreferences(key)
      const preferences = {
        ...saved,
        ...changes,
        branches: { ...saved.branches, ...changes.branches }
      }
      if (preferences.width === undefined) delete preferences.width
      this.app.saveLocalStorage(key, preferences)
    }
  }

  private setProjectTreeWidth(width: number): void {
    const { min, max } = PROJECT_TREE_WIDTH
    const value = Number.isFinite(width) ? Math.min(max, Math.max(min, Math.round(width))) : PROJECT_TREE_WIDTH.initial
    this.projectTreeEl.style.setProperty('--pm-project-tree-width', `${value}px`)
    this.projectTreeResize.setAttribute('aria-valuenow', String(value))
  }

  private attachProjectTreeResize(layout: HTMLElement): void {
    const { min, max } = PROJECT_TREE_WIDTH
    const handle = layout.createDiv({
      cls: 'pm-project-tree-resize',
      attr: {
        role: 'separator',
        tabindex: '0',
        'aria-orientation': 'vertical',
        'aria-label': t('header.resizeProjectTree'),
        title: t('header.resetProjectTreeWidth'),
        'aria-valuemin': String(min),
        'aria-valuemax': String(max)
      }
    })
    this.projectTreeResize = handle
    handle.hidden = true
    let drag: { id: number; x: number; width: number; key: string | undefined } | undefined
    const direction = () => (getComputedStyle(layout).direction === 'rtl' ? -1 : 1)
    const limit = (width: number) =>
      Math.round(Math.min(max, Math.max(min, Math.min(width, layout.clientWidth * 0.55))))
    const currentWidth = () => this.projectTreeEl.getBoundingClientRect().width
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || drag) return
      handle.setPointerCapture(event.pointerId)
      drag = { id: event.pointerId, x: event.clientX, width: currentWidth(), key: this.projectTreeKey }
      event.preventDefault()
    })
    handle.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id || drag.key !== this.projectTreeKey) return
      this.setProjectTreeWidth(limit(drag.width + (event.clientX - drag.x) * direction()))
    })
    handle.addEventListener('pointerup', (event) => {
      if (!drag || event.pointerId !== drag.id) return
      const start = drag
      drag = undefined
      if (start.key !== this.projectTreeKey) return
      if (event.clientX === start.x) {
        this.setProjectTreeWidth(this.projectTreePreferences().width ?? PROJECT_TREE_WIDTH.initial)
        return
      }
      const width = limit(start.width + (event.clientX - start.x) * direction())
      this.setProjectTreeWidth(width)
      this.saveProjectTreePreferences({ width })
    })
    handle.addEventListener('lostpointercapture', () => {
      if (!drag) return
      drag = undefined
      this.setProjectTreeWidth(this.projectTreePreferences().width ?? PROJECT_TREE_WIDTH.initial)
    })
    handle.addEventListener('dblclick', (event) => {
      if (event.button !== 0 || drag || !this.projectTreeKey) return
      this.setProjectTreeWidth(PROJECT_TREE_WIDTH.initial)
      this.saveProjectTreePreferences({ width: undefined })
    })
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const width = limit(currentWidth() + (event.key === 'ArrowLeft' ? -16 : 16) * direction())
      this.setProjectTreeWidth(width)
      this.saveProjectTreePreferences({ width })
    })
  }

  renderProjectTree(): void {
    const nav = this.projectTreeEl
    if (!nav) return
    const focused = nav.ownerDocument.activeElement
    const restoreFocus = nav.contains(focused)
    const restoreScopeFocus = restoreFocus && focused?.hasAttribute('data-project-tree-scope')
    const spec = this.projectScope?.spec
    const index = this.plugin.index
    const active = spec?.kind === 'project' ? index.projectRef(spec.path) : undefined
    const treeScopeKey = active ? `dotpm-project-tree-scope:${active.id}` : undefined
    const treeScope = treeScopeKey && this.app.loadLocalStorage(treeScopeKey) === 'all' ? 'all' : 'current'
    const treeView = active ? `${treeScope}:${active.id}` : undefined
    const win = nav.ownerDocument.defaultView
    const outgoing =
      treeView &&
      nav.dataset.projectTreeView &&
      nav.dataset.projectTreeView !== treeView &&
      !nav.hidden &&
      win?.matchMedia('(prefers-reduced-motion: no-preference)').matches
        ? nav.querySelector<HTMLUListElement>(':scope > .pm-project-tree-lists > ul:not(.pm-project-tree-outgoing)')
        : null
    const outgoingTop = outgoing?.getBoundingClientRect().top
    const outgoingOpacity = outgoing && win?.getComputedStyle(outgoing).opacity
    outgoing?.getAnimations().forEach((animation) => animation.cancel())
    nav.empty()
    if (active) {
      const ancestors = index.ancestorRefs(active.path)
      const root = ancestors[0] ?? active
      const parent = ancestors.at(-1)
      const showAll = treeScope === 'all'
      const includeArchived = this.plugin.settings.showArchivedProjects || index.isArchived(active.path)
      const key = `dotpm-project-tree:${root.id}`
      if (this.projectTreeKey !== key) {
        this.projectTreeKey = key
        const preferences = this.projectTreePreferences()
        this.projectTreeOpen = preferences.visible ?? !Platform.isPhone
        this.setProjectTreeWidth(preferences.width ?? PROJECT_TREE_WIDTH.initial)
      }
      const { branches } = this.projectTreePreferences()
      const defaultExpanded = new Set([active.id, ...ancestors.map((ref) => ref.id)])
      nav.createDiv({ cls: 'pm-project-tree-heading', text: t('header.projectTree') })
      const scope = nav.createDiv({
        cls: 'pm-project-tree-scope',
        attr: { role: 'group', 'aria-label': t('header.projectTreeScope') }
      })
      for (const [mode, label] of [
        ['current', t('header.projectTreeCurrentProject')],
        ['all', t('header.projectTreeAllProjects')]
      ] as const) {
        const button = scope.createEl('button', {
          text: label,
          attr: {
            type: 'button',
            'aria-pressed': String(treeScope === mode),
            'data-project-tree-scope': mode
          }
        })
        button.addEventListener('click', () => {
          if (treeScope === mode || !treeScopeKey) return
          this.app.saveLocalStorage(treeScopeKey, mode)
          this.renderProjectTree()
        })
      }
      if (parent) {
        const back = nav.createEl('button', {
          cls: 'pm-project-tree-parent',
          attr: { type: 'button', title: parent.title }
        })
        setIcon(back.createSpan(), 'corner-left-up')
        back.createSpan({ text: t('header.projectTreeBackToParent') })
        back.addEventListener(
          'click',
          safeAsync(() => this.goTo({ kind: 'project', path: parent.path }, false))
        )
      }
      const drag =
        this.plugin.settings.projectManualOrder !== false
          ? this.projectTreeReorder(showAll ? undefined : active.path)
          : undefined
      const renderNode = (list: HTMLElement, ref: ProjectRef): void => {
        const children = index.childRefs(ref.path, includeArchived)
        const item = list.createEl('li')
        if (list.parentElement?.tagName === 'LI') {
          const guide = item.createSvg('svg', { cls: 'pm-project-tree-guide', attr: { 'aria-hidden': 'true' } })
          guide.createSvg('rect', { cls: 'pm-project-tree-guide-vertical' })
          guide.createSvg('rect', { cls: 'pm-project-tree-guide-horizontal', attr: { y: '14', width: '14' } })
        }
        const row = item.createDiv('pm-project-tree-row')
        const current = ref.path === active.path
        const branch = children.length
          ? row.createEl('button', {
              cls: 'clickable-icon pm-project-tree-fold',
              attr: { type: 'button', 'aria-label': ref.title }
            })
          : row.createSpan({ cls: 'pm-project-tree-fold', attr: { 'aria-hidden': 'true' } })
        if (children.length) setIcon(branch, 'chevron-right')
        const link = row.createEl('button', {
          cls: 'pm-project-tree-project',
          attr: { type: 'button', title: ref.title }
        })
        drag?.(ref, row, link)
        if (current) link.setAttribute('aria-current', 'page')
        renderGlyph(link, { icon: ref.icon ?? 'folder', color: ref.color })
        link.createSpan({ cls: 'pm-project-tree-name', text: ref.title })
        link.addEventListener(
          'click',
          safeAsync(async () => {
            if (Platform.isPhone) {
              this.projectTreeOpen = false
              this.syncProjectTree()
            }
            if (!current) await this.goTo({ kind: 'project', path: ref.path }, false)
          })
        )
        if (!children.length) return
        const childList = item.createEl('ul')
        let foldAnimation: Animation | undefined
        const sync = (expanded: boolean, animate = false): void => {
          branch.setAttribute('aria-expanded', String(expanded))
          childList.inert = !expanded
          if (!animate || nav.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            foldAnimation?.cancel()
            foldAnimation = undefined
            childList.hidden = !expanded
            return
          }
          const from = childList.getBoundingClientRect().height
          foldAnimation?.cancel()
          childList.hidden = false
          const to = expanded ? childList.getBoundingClientRect().height : 0
          const animation = childList.animate(
            [
              { height: `${from}px`, overflow: 'clip' },
              { height: `${to}px`, overflow: 'clip' }
            ],
            { duration: 225, easing: 'cubic-bezier(0.25, 0.8, 0.35, 1)' }
          )
          foldAnimation = animation
          animation.addEventListener('finish', () => {
            if (foldAnimation !== animation) return
            foldAnimation = undefined
            childList.hidden = !expanded
          })
        }
        sync(branches?.[ref.id] ?? defaultExpanded.has(ref.id))
        branch.addEventListener('click', () => {
          const expanded = branch.getAttribute('aria-expanded') !== 'true'
          this.saveProjectTreePreferences({ branches: { [ref.id]: expanded } })
          sync(expanded, true)
        })
        for (const child of index.orderedProjectRefs(children)) renderNode(childList, child)
      }
      const lists = nav.createDiv('pm-project-tree-lists')
      const list = lists.createEl('ul')
      nav.dataset.projectTreeView = treeView
      const roots = showAll ? index.orderedProjectRefs(index.rootRefs(includeArchived)) : [active]
      for (const ref of roots) renderNode(list, ref)
      if (outgoing && outgoingTop !== undefined) {
        const motion = { duration: 230, easing: 'cubic-bezier(0.25, 0.8, 0.35, 1)' }
        const offset = outgoingTop - list.getBoundingClientRect().top
        outgoing.inert = true
        outgoing.setAttribute('aria-hidden', 'true')
        outgoing.addClass('pm-project-tree-outgoing')
        outgoing.style.insetBlockStart = `${offset}px`
        lists.appendChild(outgoing)
        const fade = outgoing.animate([{ opacity: outgoingOpacity || 1 }, { opacity: 0 }], { ...motion, duration: 155 })
        fade.addEventListener('finish', () => outgoing.remove())
        list.animate(
          [
            { opacity: 0.25, transform: 'translateY(3px)' },
            { opacity: 1, transform: 'none' }
          ],
          motion
        )
      }
    } else {
      this.projectTreeKey = undefined
      delete nav.dataset.projectTreeView
    }
    this.syncProjectTree()
    if (restoreFocus) {
      const selector = restoreScopeFocus ? '[data-project-tree-scope][aria-pressed="true"]' : '[aria-current="page"]'
      nav.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
    }
  }

  private projectTreeReorder(scopeRoot?: string) {
    let source: { ref: ProjectRef; link: HTMLButtonElement } | undefined
    let targetRow: HTMLElement | undefined
    const clearTarget = (): void => {
      targetRow?.removeAttribute('data-pm-project-drop')
      targetRow = undefined
    }
    const finish = (): void => {
      source?.link.removeClass('pm-project-tree-dragging')
      source = undefined
      clearTarget()
    }
    return (ref: ProjectRef, row: HTMLElement, link: HTMLButtonElement): void => {
      const placement = (event: DragEvent): TreeDrop => {
        const bounds = row.getBoundingClientRect()
        const offset = (event.clientY - bounds.top) / bounds.height
        return offset < 0.27 ? 'before' : offset > 0.73 ? 'after' : 'inside'
      }
      const canDrop = (moving: string, position: TreeDrop): boolean =>
        (ref.path !== scopeRoot || position === 'inside') &&
        projectDropParent(this.plugin, [moving], ref.path, position) !== undefined
      link.draggable = ref.path !== scopeRoot
      link.addEventListener('dragstart', (event) => {
        if (!link.draggable) {
          event.preventDefault()
          return
        }
        if (!event.dataTransfer) return
        finish()
        source = { ref, link }
        event.dataTransfer.setData('application/x-projectm-project', ref.id)
        event.dataTransfer.effectAllowed = 'move'
        link.addClass('pm-project-tree-dragging')
      })
      link.addEventListener('dragend', finish)
      row.addEventListener('dragover', (event) => {
        if (!source) return
        const position = placement(event)
        if (!canDrop(source.ref.path, position)) {
          clearTarget()
          return
        }
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        if (targetRow !== row) clearTarget()
        row.dataset.pmProjectDrop = position
        targetRow = row
      })
      row.addEventListener('dragleave', (event) => {
        if (targetRow === row && !row.contains(event.relatedTarget as Node | null)) clearTarget()
      })
      row.addEventListener(
        'drop',
        safeAsync(async (event: DragEvent) => {
          if (!source) return
          const moving = source.ref.path
          const position = placement(event)
          finish()
          if (!canDrop(moving, position)) return
          event.preventDefault()
          const treeKey = this.projectTreeKey
          const destinationRoot = this.plugin.index.ancestorRefs(ref.path)[0] ?? ref
          if (!(await moveProjectRows(this.plugin, [moving], ref.path, position)) || position !== 'inside') return
          const changes = { branches: { [ref.id]: true } }
          const destinationKey = `dotpm-project-tree:${destinationRoot.id}`
          this.saveProjectTreePreferences(changes, destinationKey)
          if (treeKey && treeKey !== destinationKey) this.saveProjectTreePreferences(changes, treeKey)
          this.renderProjectTree()
        })
      )
    }
  }

  /** The folder a project sits in. A project owns its folder, so that is the one holding it. */
  private containingFolder(projectPath: string): string {
    return folderOf(projectFolderOf(this.app, projectPath) ?? projectPath)
  }

  private renderViewSlot(parent: HTMLElement): void {
    this.viewSlot = new SavedViewSlot(parent, {
      onOpen: (anchor) => this.openSavedViews(anchor),
      onSave: safeAsync(() => this.updateActiveView())
    })
  }

  private openSavedViews(anchor: HTMLElement): void {
    const primary = this.projectScope?.primary
    openSavedViewsPopover(anchor, {
      views: this.savedViews().map((view) => ({
        id: view.id,
        name: view.name,
        modeIcon: view.viewMode ? MODE_ICONS[view.viewMode] : undefined,
        isDefault: view.isDefault
      })),
      activeId: this.activeSavedViewId,
      changes: this.viewChanges(),
      canSave:
        countActiveFilters(this.query.filter) > 0 ||
        !sameValue(this.sort, makeDefaultSort()) ||
        Object.keys(this.fields).length > 0 ||
        this.currentView !== this.projectScope?.config.defaultView,
      builtInName: t('header.allTasks'),
      storageNote:
        this.projectScope?.spec.kind === 'project' && primary
          ? t('header.storedInNote', { name: primary.title })
          : t('header.storedInSettings'),
      onSelect: (id) => this.handleSavedViewSelect(id),
      onSave: (name, isDefault) => this.handleSavedViewSave(name, isDefault),
      onUpdate: (id) => this.handleSavedViewUpdate(id),
      onRevert: () => this.handleSavedViewSelect(this.activeSavedViewId),
      onRename: (id, name) => this.handleSavedViewRename(id, name),
      onDelete: (id) => this.handleSavedViewDelete(id),
      onReorder: (ids) => this.handleSavedViewReorder(ids),
      onSetDefault: (id) => this.handleSavedViewDefault(id)
    })
  }

  private async updateActiveView(): Promise<void> {
    if (this.activeSavedViewId && this.viewChanges().length) await this.handleSavedViewUpdate(this.activeSavedViewId)
  }

  private renderQuerySlot(parent: HTMLElement): void {
    this.searchBox = new SearchBox(parent, this.searchProps())
    this.filterButton = new ChipButton(parent)
      .setIcon('list-filter')
      .setLabel(t('header.filter'))
      .setAriaLabel(t('header.filter'))
      .onClick(() => this.openFilter())
    this.sortButton = null
    this.groupButton = null
    this.fieldsButton = null
    if (this.currentView !== 'gantt') {
      const sortButton = new ChipButton(parent).setAriaLabel(t('header.sort'))
      sortButton.onClick(() => this.openSort(sortButton.el))
      this.sortButton = sortButton
    }
    if (this.currentView === 'kanban') {
      const groupButton = new ChipButton(parent).setIcon('group').setAriaLabel(t('header.group'))
      groupButton.onClick(() => this.openGroup(groupButton.el))
      this.groupButton = groupButton
    }
    const fieldsButton = new ChipButton(parent)
      .setIcon('columns-3')
      .setLabel(t('header.fields'))
      .setAriaLabel(t('header.fields'))
    fieldsButton.onClick(() => this.openFields(fieldsButton.el))
    this.fieldsButton = fieldsButton
  }

  private searchProps(): SearchBoxProps {
    return {
      value: this.query.text,
      label: t('header.search'),
      placeholder: t('taskForm.searchTasks'),
      clearLabel: t('common.clear'),
      onChange: (value) => {
        this.query.text = value
        this.syncHeader()
        this.refreshSubview()
      }
    }
  }

  private openFilter(): void {
    this.queryBarOpen = true
    if (!this.filterBar) this.renderFilterBar()
    this.filterBar?.openPicker()
  }

  private openSort(anchor: HTMLElement): void {
    openSortPopover(anchor, this.sortProps())
  }

  /** What the sort panel edits; `after` runs after each change, for a host that follows it. */
  private sortProps(after?: () => void): SortPopoverProps {
    const sorted = (): void => {
      this.syncHeader()
      this.refreshSubview()
      void this.persistFilter()
      after?.()
    }
    return {
      fields: sortFields(this.projectScope?.config),
      sort: this.sort,
      onChange: sorted,
      manualOrder:
        this.currentView === 'table'
          ? {
              enabled: this.tableManualOrder,
              onChange: (enabled) => {
                this.tableManualOrder = enabled
                this.syncHeader()
                if (this.subview instanceof TableView) this.subview.setManualOrder(enabled)
                void this.persistFilter()
                after?.()
              }
            }
          : undefined,
      onReset: () => {
        this.sort.splice(0, this.sort.length, ...structuredClone(this.activeView()?.sort ?? makeDefaultSort()))
        sorted()
      }
    }
  }

  private openFields(anchor: HTMLElement): void {
    const props = this.fieldsProps()
    if (props) openFieldsPopover(anchor, props)
  }

  private fieldsProps(after?: () => void): FieldsPopoverProps | null {
    const scope = this.projectScope
    if (!scope) return null
    return {
      mode: this.currentView,
      fields: this.fields,
      catalog: scope.fieldCatalog(),
      onChange: () => {
        this.handleFieldsChange()
        after?.()
      }
    }
  }

  /** The sort as the header names it, or nothing at the default. */
  private sortSummary(): SortSummary | undefined {
    return sameValue(this.sort, makeDefaultSort()) ? undefined : summarizeSort(sortFields(), this.sort)
  }

  /** How many of the mode's default fields are hidden, counted only once the mode's fields were changed. */
  private hiddenFieldCount(): number {
    const scope = this.projectScope
    if (!scope || this.fields[this.currentView] === undefined) return 0
    // Counted against the defaults, so fields a mode never shows unless asked don't read as hidden.
    const catalog = scope.fieldCatalog()
    const shown = shownFields(this.fields, this.currentView, catalog)
    return shownFields({}, this.currentView, catalog).filter((id) => !shown.includes(id)).length
  }

  /** The query and option controls as the Tune button lists them in a narrow header. */
  private tuneItems(): TuneItem[][] {
    const scope = this.projectScope
    const primary = scope?.primary
    if (!scope || !primary) return []
    const mode: TuneItem = {
      icon: MODE_ICONS[this.currentView],
      label: t('header.mode'),
      state: modeLabel(this.currentView),
      onOpen: (anchor) => this.showModeMenu(anchor, scope, primary)
    }
    const filters = countActiveFilters(this.query.filter)
    const sort = this.sortSummary()
    const hidden = this.hiddenFieldCount()
    const query: TuneItem[] = [
      {
        icon: 'search',
        label: t('header.search'),
        state: this.query.text.trim(),
        onOpen: (anchor) => openSearchPopover(anchor, this.searchProps())
      },
      {
        icon: 'list-filter',
        label: t('header.filter'),
        state: filters ? String(filters) : '',
        onOpen: () => this.openFilter()
      }
    ]
    if (this.currentView !== 'gantt') {
      query.push({
        icon: 'arrow-down-up',
        label: t('header.sort'),
        state:
          this.currentView === 'table' && this.tableManualOrder
            ? t('header.manualOrder')
            : sort
              ? `${sort.label} ${sort.more}`.trim()
              : '',
        onOpen: (anchor) => this.openSort(anchor)
      })
    }
    if (this.currentView === 'kanban') {
      query.push({
        icon: 'group',
        label: t('header.group'),
        state: this.groupSummary(),
        onOpen: (anchor) => this.openGroup(anchor)
      })
    }
    query.push({
      icon: 'columns-3',
      label: t('header.fields'),
      state: hidden ? tn('header.hiddenCount', hidden) : '',
      onOpen: (anchor) => this.openFields(anchor)
    })
    const options = this.viewOptions(scope).map((option): TuneItem => {
      if (option !== 'zoom') return { icon: option.icon, label: option.label, state: option.value, onOpen: option.run }
      return {
        icon: 'zoom-in',
        label: t('timeline.zoom'),
        control: (parent) => {
          const sync = (): void => {
            stepper.setValue(`${this.zoom}%`, this.zoom <= MIN_ZOOM, this.zoom >= MAX_ZOOM)
          }
          const stepper = new Stepper(parent, this.zoomProps(sync))
          sync()
        }
      }
    })
    return [[mode], query, options]
  }

  /** Rebuilt rather than refreshed, so the table keeps its scroll position while its columns change. */
  private handleFieldsChange(): void {
    this.syncHeader()
    this.renderCurrentView()
    void this.persistFilter()
  }

  /** The board's field as the Group button names it, or nothing while the board groups by status untouched. */
  private groupSummary(): string {
    const setup = this.groupSetup()
    if (!setup) return ''
    const field = boardField(setup, this.group)
    const columns = this.group.columns?.[field]
    const changed =
      field !== makeDefaultGroup().field ||
      !!this.group.hideEmpty ||
      !!columns?.hidden?.length ||
      !!columns?.order?.length
    return changed ? filterFieldLabel(field, setup.ctx.customFields) : ''
  }

  private groupSetup() {
    const scope = this.projectScope
    return scope ? scope.filterSetup(this.query.filter, personKeyer(this.plugin.app)) : null
  }

  /** The board's columns as the Group popover lists them: every task the filter lets through. */
  private boardColumnsNow(): BoardColumn[] {
    const setup = this.groupSetup()
    const scope = this.projectScope
    if (!setup || !scope) return []
    const candidates = boardCandidates(scope.tasks(), shownFields(this.fields, 'kanban', scope.fieldCatalog()))
    const shown = candidates.filter((task) => matchesQuery(task, this.query, setup.ctx))
    return boardColumns(setup, this.group, shown)
  }

  private openGroup(anchor: HTMLElement): void {
    const props = this.groupProps()
    if (props) openGroupPopover(anchor, props)
  }

  private groupProps(after?: () => void): GroupPopoverProps | null {
    const setup = this.groupSetup()
    if (!setup) return null
    return {
      fields: groupableFields(setup).map((id) => ({ id, label: filterFieldLabel(id, setup.ctx.customFields) })),
      group: this.group,
      field: () => boardField(setup, this.group),
      columns: () => this.boardColumnsNow(),
      onChange: () => {
        this.syncHeader()
        this.refreshSubview()
        void this.persistFilter()
        after?.()
      }
    }
  }

  /** The phone's sheet: a tab for each query control this mode has, and how many tasks it leaves. */
  private tuneSheet(): TuneSheetProps {
    const tabs: SheetTab[] = []
    const setup = this.filterSetup()
    if (setup) {
      tabs.push({
        id: 'filter',
        label: t('header.filter'),
        badge: () => countActiveFilters(this.query.filter),
        render: (parent, changed) =>
          renderFilterPanel(
            parent,
            setup,
            () => {
              this.handleFilterMutation()
              changed()
            },
            'list',
            { showClear: false }
          )
      })
    }
    if (this.currentView !== 'gantt') {
      tabs.push({
        id: 'sort',
        label: t('header.sort'),
        render: (parent, changed) => renderSortPanel(parent, this.sortProps(changed))
      })
    }
    if (this.currentView === 'kanban') {
      tabs.push({
        id: 'group',
        label: t('header.group'),
        render: (parent, changed) => {
          const props = this.groupProps(changed)
          if (props) renderGroupPanel(parent, props)
        }
      })
    }
    tabs.push({
      id: 'fields',
      label: t('header.fields'),
      render: (parent, changed) => {
        const props = this.fieldsProps(changed)
        if (props) renderFieldsPanel(parent, props)
      }
    })
    return {
      tabs,
      clear: {
        label: t('filter.clearAll'),
        canClear: () => countActiveFilters(this.query.filter) > 0,
        onClear: () => {
          this.query.filter.conditions = []
          this.query.filter.showArchived = false
          this.handleFilterMutation()
        }
      },
      doneLabel: () => tn('header.showTasks', this.taskCounts().shown)
    }
  }

  /** The phone's "More" menu: the view mode and the options the header has no room for. */
  private fillMoreMenu(menu: PlatformMenu, anchor: HTMLElement): void {
    const scope = this.projectScope
    const primary = scope?.primary
    if (!scope || !primary) return
    this.addModeItems(menu, scope, primary)
    const options = this.viewOptions(scope)
    if (options.length) menu.addSeparator()
    for (const option of options) {
      if (option === 'zoom') {
        menu.addItem((item) =>
          item
            .setTitle(t('timeline.zoomIn'))
            .setIcon('zoom-in')
            .setDisabled(this.zoom >= MAX_ZOOM)
            .onClick(() => this.setZoom(stepZoom(this.zoom, 1)))
        )
        menu.addItem((item) =>
          item
            .setTitle(t('timeline.zoomOut'))
            .setIcon('zoom-out')
            .setDisabled(this.zoom <= MIN_ZOOM)
            .onClick(() => this.setZoom(stepZoom(this.zoom, -1)))
        )
        continue
      }
      const title = option.value ? `${option.label}: ${option.value}` : option.label
      menu.addItem((item) =>
        item
          .setTitle(title)
          .setIcon(option.icon)
          .onClick(() => option.run(anchor))
      )
    }
    if (this.currentView === 'gantt') {
      menu.addSeparator()
      menu.addItem((item) =>
        item
          .setTitle(t('projectView.addMilestone'))
          .setIcon('diamond')
          .onClick(() => this.addTask(anchor, { type: 'milestone' }))
      )
    }
  }

  private renderOptionsSlot(parent: HTMLElement, scope: ProjectScope): void {
    this.zoomStepper = null
    this.daysButton = null
    for (const option of this.viewOptions(scope)) {
      if (option === 'zoom') {
        this.zoomStepper = new Stepper(parent, this.zoomProps())
        continue
      }
      const chip = new ChipButton(parent).setAriaLabel(option.label)
      if (option.chip === 'value') chip.setLabel(option.value ?? '').setChevron(true)
      else chip.setIcon(option.icon).setLabel(option.chip === 'label' ? option.label : '')
      if (option.chip === 'icon') chip.setTooltip(option.label)
      chip.onClick(() => option.run(chip.el))
      if (option.id === 'days') this.daysButton = chip
    }
  }

  /**
   * The mode's own controls in their order: on the timeline Today, the scale, the zoom and the
   * non-working days, then collapse on anything but the board. The options slot, the Tune list
   * and the More menu all draw this list; `zoom` stands for the stepper, which each draws its own way.
   */
  private viewOptions(scope: ProjectScope): (ViewOption | 'zoom')[] {
    const options: (ViewOption | 'zoom')[] = []
    if (this.currentView === 'gantt') {
      options.push(
        {
          id: 'today',
          icon: 'calendar-check',
          label: t('gantt.today'),
          chip: 'label',
          run: () => this.scrollToToday()
        },
        {
          id: 'scale',
          icon: 'calendar-range',
          label: t('header.scale'),
          value: granularityLabel(this.granularity),
          chip: 'value',
          run: (anchor) => this.openScaleMenu(anchor)
        },
        'zoom',
        {
          id: 'days',
          icon: 'calendar-off',
          label: t('timeline.nonWorkingDays'),
          chip: 'icon',
          run: (anchor) => this.openNonWorkingDays(anchor)
        }
      )
    }
    if (this.currentView !== 'kanban') {
      const anyCollapsed = collapsedTaskIds(this.plugin.settings, scope.projects).size > 0
      options.push({
        id: 'collapse',
        icon: anyCollapsed ? 'chevrons-up-down' : 'chevrons-down-up',
        label: anyCollapsed ? t('gantt.expandAll') : t('gantt.collapseAll'),
        chip: 'icon',
        run: () => this.toggleCollapseAll(scope, anyCollapsed)
      })
    }
    return options
  }

  private scrollToToday(): void {
    if (this.subview instanceof GanttView) this.subview.scrollToToday()
  }

  private openScaleMenu(anchor: HTMLElement): void {
    const menu = new Menu()
    for (const granularity of GANTT_GRANULARITIES) {
      menu.addItem((item) =>
        item
          .setTitle(granularityLabel(granularity))
          .setChecked(granularity === this.granularity)
          .onClick(() => this.setGranularity(granularity))
      )
    }
    showMenuBelow(menu, anchor)
  }

  /** The zoom stepper's handlers; `onZoom` runs after each step, for a stepper the header doesn't keep current. */
  private zoomProps(onZoom?: () => void): StepperProps {
    const zoomTo = (zoom: number): void => {
      this.setZoom(zoom)
      onZoom?.()
    }
    return {
      decreaseLabel: t('timeline.zoomOut'),
      increaseLabel: t('timeline.zoomIn'),
      resetLabel: t('timeline.resetZoom'),
      onDecrease: () => zoomTo(stepZoom(this.zoom, -1)),
      onIncrease: () => zoomTo(stepZoom(this.zoom, 1)),
      onReset: () => zoomTo(100)
    }
  }

  private openNonWorkingDays(anchor: HTMLElement): void {
    openNonWorkingDaysPopover(anchor, {
      days: this.nonWorkingDays,
      holidays: this.plugin.settings.holidays,
      onChange: () => this.handleTimelineAxisChange(),
      onHolidaysChange: safeAsync(async (holidays: string[]) => {
        this.plugin.settings.holidays = holidays
        await this.plugin.saveSettings()
        if (this.nonWorkingDays.holidays) this.renderCurrentView()
      })
    })
  }

  private toggleCollapseAll(scope: ProjectScope, anyCollapsed: boolean): void {
    setAllCollapsed(this.plugin.settings, scope.projects, !anyCollapsed)
    void this.plugin.saveSettings()
    this.renderHeader()
    this.refreshSubview()
  }

  /** Column widths a phone keeps for itself, since widths set on a wider screen rarely suit it. */
  private phoneWidthsKey(): string {
    return `dotpm-table-widths:${this.projectScope?.key ?? ''}`
  }

  /** The view's fields with this phone's own column widths in place of the view's, for the table to edit. */
  private phoneTableFields(): ViewFields {
    const fields = structuredClone(this.fields)
    const widths = this.app.loadLocalStorage(this.phoneWidthsKey()) as Record<string, number> | null
    if (fields.table) delete fields.table.widths
    if (widths && this.projectScope) {
      const visible = shownFields(this.fields, 'table', this.projectScope.fieldCatalog())
      fields.table = { visible: fields.table?.visible ?? visible, widths }
    }
    return fields
  }

  /** Keeps widths on the device and takes only which columns show back into the view. */
  private handlePhoneTableFields(edited: ViewFields): void {
    const scope = this.projectScope
    if (!scope) return
    const widths = edited.table?.widths
    this.app.saveLocalStorage(this.phoneWidthsKey(), widths && Object.keys(widths).length ? widths : null)
    const catalog = scope.fieldCatalog()
    const visible = shownFields(edited, 'table', catalog)
    if (!sameValue(visible, shownFields(this.fields, 'table', catalog))) {
      this.fields.table = { ...this.fields.table, visible }
      tidyFields(this.fields, catalog)
    }
    this.handleFieldsChange()
  }

  /** Zoom is per device, so it is kept in this vault's local storage rather than in the view. */
  private zoomKey(): string {
    return `dotpm-timeline-zoom:${this.projectScope?.key ?? ''}`
  }

  private setZoom(zoom: number): void {
    if (zoom === this.zoom) return
    this.zoom = zoom
    this.rememberZoom()
    if (this.subview instanceof GanttView) this.subview.setZoom(zoom)
  }

  private rememberZoom(): void {
    this.app.saveLocalStorage(this.zoomKey(), this.zoom === 100 ? null : this.zoom)
    this.syncHeader()
  }

  private handleTimelineAxisChange(): void {
    this.syncHeader()
    this.renderCurrentView()
    void this.persistFilter()
  }

  private setGranularity(granularity: GanttGranularity): void {
    if (granularity === this.granularity) return
    this.granularity = granularity
    void this.persistFilter()
    this.renderHeader()
    this.renderCurrentView()
  }

  private renderActionsSlot(parent: HTMLElement): void {
    const add = new SplitButton(parent).setIcon('plus').setLabel(t('projectView.addTask'))
    add.onClick(() => this.addTask(add.el))
    if (this.currentView === 'gantt') {
      add.onMenu(t('header.moreToAdd'), (anchor) => {
        const menu = new Menu()
        menu.addItem((item) =>
          item
            .setTitle(t('projectView.addMilestone'))
            .setIcon('diamond')
            .onClick(() => this.addTask(add.el, { type: 'milestone' }))
        )
        showMenuBelow(menu, anchor, 'right')
      })
    }
  }

  private filterSetup(): FilterSetup | null {
    const scope = this.projectScope
    if (!scope) return null
    const config = scope.config
    return {
      filter: this.query.filter,
      tasks: flattenTasks(scope.tasks()).map((flat) => flat.task),
      ctx: scope.filterContext(personKeyer(this.plugin.app)),
      priorities: config.priorities,
      priorityIcons: config.priorityIcons,
      projects: scope.isMulti
        ? scope.projects.map((project) => ({ id: project.id, title: project.title, color: project.color }))
        : []
    }
  }

  /** The applied filters under the header. A phone reaches them through the Tune sheet instead. */
  private renderFilterBar(): void {
    const header = this.header
    const setup = this.filterSetup()
    if (!header || !setup) return
    header.bar.empty()
    this.filterBar = null
    if (!this.queryBarOpen || Platform.isPhone) return
    const counts = this.taskCounts()
    this.filterBar = new FilterBar(header.bar, {
      ...setup,
      summary: t('header.shownSummary', { shown: counts.shown, total: counts.total }),
      onChange: () => this.handleFilterMutation(),
      onClose: () => {
        this.queryBarOpen = false
        this.renderFilterBar()
      }
    })
  }

  private handleFilterMutation(): void {
    this.syncHeader()
    void this.persistFilter()
    this.refreshSubview()
  }

  private handleSavedViewSelect(id: string | null): void {
    if (!this.projectScope) return
    if (id === null) {
      this.query.filter = makeDefaultFilter()
      this.activeSavedViewId = null
    } else {
      const sv = this.savedViews().find((v) => v.id === id)
      if (!sv) return
      this.applySavedView(sv)
    }
    this.queryBarOpen = countActiveFilters(this.query.filter) > 0
    void this.persistFilter()
    this.renderHeader()
    this.renderCurrentView()
  }

  private async handleSavedViewSave(name: string, isDefault: boolean): Promise<void> {
    if (!this.projectScope) return
    const sv: SavedView = {
      id: makeId(),
      name,
      filter: structuredClone(this.query.filter),
      sort: structuredClone(this.sort),
      group: structuredClone(this.group),
      fields: structuredClone(this.fields),
      viewMode: this.currentView,
      ganttGranularity: this.granularity,
      nonWorkingDays: structuredClone(this.nonWorkingDays),
      ...(isDefault ? { isDefault: true } : {})
    }
    this.activeSavedViewId = sv.id
    const views = isDefault ? withDefault(this.savedViews(), null) : this.savedViews()
    await this.persistSavedViews([...views, sv])
    void this.persistFilter()
    this.syncHeader()
  }

  private async handleSavedViewUpdate(id: string): Promise<void> {
    const views = this.savedViews()
    const sv = views.find((v) => v.id === id)
    if (!sv) return
    sv.filter = structuredClone(this.query.filter)
    sv.viewMode = this.currentView
    sv.sort = structuredClone(this.sort)
    sv.group = structuredClone(this.group)
    sv.fields = structuredClone(this.fields)
    sv.ganttGranularity = this.granularity
    sv.nonWorkingDays = structuredClone(this.nonWorkingDays)
    this.activeSavedViewId = sv.id
    await this.persistSavedViews(views)
    void this.persistFilter()
    this.syncHeader()
  }

  private async handleSavedViewDelete(id: string): Promise<void> {
    if (this.activeSavedViewId === id) this.activeSavedViewId = null
    await this.persistSavedViews(this.savedViews().filter((v) => v.id !== id))
    void this.persistFilter()
    this.syncHeader()
  }

  private async handleSavedViewRename(id: string, name: string): Promise<void> {
    const views = this.savedViews()
    const sv = views.find((v) => v.id === id)
    if (!sv) return
    sv.name = name
    await this.persistSavedViews(views)
    this.syncHeader()
  }

  private async handleSavedViewReorder(ids: string[]): Promise<void> {
    const byId = new Map(this.savedViews().map((view) => [view.id, view]))
    await this.persistSavedViews(ids.flatMap((id) => byId.get(id) ?? []))
  }

  /** One view per scope carries the star; starring another moves it. */
  private async handleSavedViewDefault(id: string | null): Promise<void> {
    await this.persistSavedViews(withDefault(this.savedViews(), id))
  }

  private refreshSubview(): void {
    this.subview?.render()
  }

  /** With several projects in view, a new task has to say which one it belongs to. */
  openTaskDetails(project: Project, opts: Parameters<typeof openTaskModal>[2]): void {
    if (opts.task) void this.taskDetails?.open(project, opts.task, opts.onSave)
  }

  openLinkedTaskDetails(project: Project, id: string, path: string): void {
    void this.taskDetails?.openLinked(project, id, path, () => this.refreshProject())
  }

  private addTask(anchor: HTMLElement, defaults?: Parameters<typeof openTaskModal>[2]['defaults']): void {
    const scope = this.projectScope
    if (!scope?.primary) return
    const open = (project: Project): void => {
      openTaskModal(this.plugin, project, {
        defaults,
        onSave: async () => {
          await this.refreshProject()
        }
      })
    }
    if (!scope.isMulti) {
      open(scope.primary)
      return
    }
    const menu = new Menu()
    for (const project of scope.projects) {
      menu.addItem((item) =>
        item
          .setTitle(project.title)
          .setIcon('plus')
          .onClick(() => open(project))
      )
    }
    showMenuBelow(menu, anchor)
  }

  private renderCurrentView(): void {
    const scope = this.projectScope
    if (!scope?.primary) return

    let savedGanttScroll: ReturnType<GanttView['getScrollPosition']> | null = null
    let savedGanttLabelWidth: number | null = null
    if (this.currentView === 'gantt' && this.subview instanceof GanttView) {
      savedGanttScroll = this.subview.getScrollPosition()
      savedGanttLabelWidth = this.subview.getLabelWidth()
    }

    let savedTableScrollTop: number | null = null
    if (this.currentView === 'table' && this.subview instanceof TableView) {
      savedTableScrollTop = this.subview.getScrollTop()
    }

    this.subview?.destroy?.()
    this.bodyEl.empty()
    this.subview = null

    switch (this.currentView) {
      case 'table': {
        const phone = Platform.isPhone
        const fields = phone ? this.phoneTableFields() : this.fields
        const table = new TableView(
          this.bodyEl,
          scope,
          this.plugin,
          () => this.refreshProject(),
          this.query,
          this.sort,
          this.tableManualOrder,
          safeAsync(async () => {
            this.syncHeader()
            await this.persistFilter()
          }),
          this.keyScope,
          fields,
          () => (phone ? this.handlePhoneTableFields(fields) : this.handleFieldsChange())
        )
        if (savedTableScrollTop !== null) table.setPendingScrollTop(savedTableScrollTop)
        this.subview = table
        break
      }
      case 'gantt': {
        const gantt = new GanttView(
          this.bodyEl,
          scope,
          this.plugin,
          () => this.refreshProject(),
          this.query,
          this.granularity,
          this.keyScope,
          this.fields,
          this.zoom,
          this.nonWorkingDays,
          (zoom) => {
            this.zoom = zoom
            this.rememberZoom()
          }
        )
        if (savedGanttScroll) gantt.setPendingScroll(savedGanttScroll)
        if (savedGanttLabelWidth !== null) gantt.setLabelWidth(savedGanttLabelWidth)
        this.subview = gantt
        break
      }
      case 'kanban':
        this.subview = new KanbanView(
          this.bodyEl,
          scope,
          this.plugin,
          () => this.refreshProject(),
          this.query,
          this.sort,
          this.group,
          this.fields,
          (anchor) => this.openGroup(anchor)
        )
        break
    }
    this.bodyEl.toggleClass('pm-content--kanban', this.currentView === 'kanban')
    this.subview?.render()
  }

  /**
   * Re-render from the projects in memory. Coalesced, so a mutation reporting back
   * through both its own callback and the store's change event paints once.
   */
  refreshProject(): Promise<void> {
    if (this.pendingRefresh) return this.pendingRefresh
    this.pendingRefresh = new Promise((resolve) => {
      window.setTimeout(() => {
        this.pendingRefresh = null
        if (this.projectScope?.primary) {
          if (this.subview?.refresh) this.subview.refresh()
          else if (this.subview) this.subview.render()
          else this.renderCurrentView()
          this.syncHeader()
        }
        resolve()
      }, 0)
    })
    return this.pendingRefresh
  }
}
