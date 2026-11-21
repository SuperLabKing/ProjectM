import { setIcon } from 'obsidian'
import type PMPlugin from '#main'
import { personKeyer, ProjectScope, type ProjectRef } from '#store'
import {
  applyTaskFilterFlat,
  findTaskById,
  flattenTasks,
  formatDateShort,
  getStatusConfig,
  linkedTaskState,
  locale,
  parsePlainDate,
  t,
  today,
  type Project,
  type Task,
  type StatusConfig,
  type TaskQuery
} from '@dotpm/core'
import type { AgendaDate } from '../agendaEntries'
import type { SubView } from '../SubView'
import {
  axisDate,
  chartBounds,
  datesOf,
  timelineChecklist,
  timelineDay,
  timelineWindow,
  type FixedTimelineSpan,
  type TimelineDates
} from './timelineDates'

type Mode = 'plan' | 'actual' | 'compare'
type Span = 'auto' | FixedTimelineSpan
type SpanAnchors = Partial<Record<FixedTimelineSpan, string>>
type Level = { project?: string; task?: string }
type RowKind = 'project' | 'subproject' | 'task' | 'checklist'

interface Row {
  id: string
  title: string
  kind: RowKind
  plan: TimelineDates
  actual: TimelineDates
  status?: string
  destination?: Level
  depth?: number
  branchKey?: string
}

const modes = [
  { id: 'plan', label: 'projectTimeline.plan', hint: 'projectTimeline.planHint' },
  { id: 'actual', label: 'projectTimeline.actual', hint: 'projectTimeline.actualHint' },
  { id: 'compare', label: 'projectTimeline.compare', hint: 'projectTimeline.compareHint' }
] as const
const spans = ['auto', 'around7', 'around14', 'month', 'quarter', 'year'] as const
const marks = {
  todo: 'status.todo',
  active: 'projectTimeline.ongoing',
  held: 'agenda.held',
  done: 'projectTimeline.completed',
  cancelled: 'projectTimeline.cancelled'
} as const

export class ProjectTimelineView implements SubView {
  private level: Level = {}
  private mode: Mode = 'compare'
  private span: Span
  private spanAnchors: SpanAnchors
  private layout: 'drilldown' | 'nested' | undefined
  private readonly expansionKey: string
  private readonly spanKey: string
  private expanded: Set<string>
  private selected: string | undefined
  private request = 0

  constructor(
    private host: HTMLElement,
    private scope: ProjectScope,
    private plugin: PMPlugin,
    private query: TaskQuery
  ) {
    const owner =
      scope.spec.kind === 'project' || scope.spec.kind === 'subtree'
        ? 'project:' + (scope.primary?.id ?? scope.spec.path)
        : scope.key
    this.expansionKey = 'projectmaster-timeline-expanded:' + owner
    this.spanKey = 'projectmaster-timeline-span:' + owner
    this.expanded = this.loadExpanded()
    const { span, anchors } = this.loadSpanPreferences()
    this.span = span
    this.spanAnchors = anchors
  }

  private loadSpanPreferences(): { span: Span; anchors: SpanAnchors } {
    const saved = this.plugin.app.loadLocalStorage(this.spanKey) as {
      span?: unknown
      anchors?: Partial<Record<FixedTimelineSpan, unknown>>
    } | null
    const previous =
      saved?.span === 'threeWeeks'
        ? 'around14'
        : saved?.span === 'week' || saved?.span === 'twoWeeks'
          ? 'around7'
          : saved?.span
    const span = spans.find((choice) => choice === previous) ?? 'auto'
    const anchors: SpanAnchors = {}
    for (const choice of spans) {
      if (choice === 'auto') continue
      const date = saved?.anchors?.[choice]
      if (typeof date === 'string' && parsePlainDate(date)) anchors[choice] = date
    }
    return { span, anchors }
  }

  private rememberSpan(span: Span, date?: string | null): void {
    const { anchors } = this.loadSpanPreferences()
    // Keep a calendar date so restoring the range also works after the current month changes.
    if (span !== 'auto') {
      if (date === null) delete anchors[span]
      else if (date) anchors[span] = date
    }
    this.span = span
    this.spanAnchors = anchors
    this.plugin.app.saveLocalStorage(this.spanKey, { span, anchors })
  }

  private loadExpanded(): Set<string> {
    const saved: unknown = this.plugin.app.loadLocalStorage(this.expansionKey)
    return new Set(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === 'string') : [])
  }

  private toggleBranch(key: string): void {
    // Merge with the latest preference so another tab cannot lose its expanded branches.
    const next = this.loadExpanded()
    if (this.expanded.has(key)) next.delete(key)
    else next.add(key)
    this.expanded = next
    this.plugin.app.saveLocalStorage(this.expansionKey, [...next])
    this.selected = undefined
    void this.render()
  }

  destroy(): void {
    this.request++
  }

  async render(): Promise<void> {
    const request = ++this.request
    const layout = this.plugin.settings.projectTimelineLayout === 'nested' ? 'nested' : 'drilldown'
    if (this.layout !== layout) {
      this.layout = layout
      this.level = {}
      this.selected = undefined
      this.host.empty()
    }
    const projects = this.projectRows()
    if (this.layout === 'nested') {
      try {
        const rows = await this.nestedRows(projects)
        if (request === this.request) this.paint(projects, rows)
      } catch (error) {
        if (request !== this.request) return
        console.error('[PM] Timeline', error)
        this.paint(projects, projects, undefined, undefined, t('common.somethingWentWrong'))
      }
      return
    }
    const path = this.level.project
    if (!path) {
      this.paint(projects, projects)
      return
    }
    const projectTitle = this.plugin.index.projectRef(path)?.title
    if (!projectTitle) {
      this.navigate({})
      return
    }
    if (!this.host.firstChild) this.paint(projects, [], projectTitle, undefined, t('projectTimeline.loading'))
    try {
      await this.loadRows(path, this.level.task, projects, request)
    } catch (error) {
      if (request !== this.request) return
      console.error('[PM] Timeline', error)
      this.paint(projects, [], projectTitle, undefined, t('common.somethingWentWrong'))
    }
  }

  private navigate(level: Level): void {
    this.level = level
    this.selected = undefined
    this.host.empty()
    void this.render()
    this.host.querySelector<HTMLElement>('.pm-tl-back')?.focus({ preventScroll: true })
  }

  private projectRows(): Row[] {
    const { index } = this.plugin
    const { spec, projects } = this.scope
    const paths =
      spec.kind === 'project' || spec.kind === 'subtree'
        ? [spec.path, ...index.descendantRefs(spec.path, index.isArchived(spec.path)).map((ref) => ref.path)]
        : projects.map((project) => project.filePath)
    const pathSet = new Set(paths)
    return paths.flatMap((path) => {
      const ref = index.projectRef(path)
      if (!ref) return []
      const parent = index.parentOf(path)
      return [this.projectRow(ref, parent && pathSet.has(parent.path) ? 'subproject' : 'project')]
    })
  }

  private projectRow(ref: ProjectRef, kind: 'project' | 'subproject', drill = true): Row {
    const { index } = this.plugin
    const { start, completed } = index.projectDates(ref)
    const { latestDue } = index.rollupDueSummary(ref)
    const { done, total } = index.rollupCounts(ref)
    return {
      id: ref.path,
      title: ref.title,
      kind,
      plan: datesOf(start, latestDue),
      actual: { ...datesOf('', completed), event: 'completion' },
      status: t('projectTimeline.progress', { done, total }),
      branchKey: 'project:' + ref.id,
      destination: drill ? { project: ref.path } : undefined
    }
  }

  private taskRow(project: Project, task: Task, drill: boolean, statuses: StatusConfig[]): Row {
    const status = getStatusConfig(statuses, task.status)
    return {
      id: task.id,
      title: task.title,
      kind: 'task',
      plan: task.type === 'milestone' ? datesOf('', task.due || task.start) : datesOf(task.start, task.due),
      actual: {
        ...datesOf('', status?.complete ? task.completed : ''),
        event: linkedTaskState(task.status, status) === 'cancel' ? 'cancellation' : 'completion'
      },
      status: status?.label ?? task.status,
      destination: drill ? { project: project.filePath, task: task.id } : undefined
    }
  }

  private filteredTasks(project: Project, scope: ProjectScope) {
    return applyTaskFilterFlat(
      flattenTasks(project.tasks),
      this.query,
      scope.filterContext(personKeyer(this.plugin.app))
    )
  }

  private async checklistRows(task: Task, key: string): Promise<Row[]> {
    await this.plugin.store.loadTaskBody(task)
    return timelineChecklist(task.description).map(({ line, title, mark, plan, actual }) => ({
      id: key + ':check-' + line,
      title,
      kind: 'checklist',
      plan,
      actual,
      status: t(marks[mark])
    }))
  }

  private async nestedRows(projects: Row[]): Promise<Row[]> {
    const { index, store } = this.plugin
    const projectIds = new Set(projects.map((row) => row.id))
    const projectChildren = new Map<string | null, Row[]>()
    for (const row of projects) {
      const parent = index.parentOf(row.id)?.path
      const key = parent && projectIds.has(parent) ? parent : null
      const rows = projectChildren.get(key) ?? []
      rows.push(row)
      projectChildren.set(key, rows)
    }
    const projectBranch = async (row: Row, depth: number): Promise<Row[]> => {
      const heading = { ...row, depth }
      if (!this.expanded.has(row.branchKey ?? row.id)) return [heading]
      const [subprojects, project] = await Promise.all([
        Promise.all((projectChildren.get(row.id) ?? []).map((child) => projectBranch(child, depth + 1))),
        store.loadProjectByPath(row.id)
      ])
      if (!project) return [heading, ...subprojects.flat()]
      const scope = new ProjectScope({ kind: 'project', path: row.id }, [project], store)
      const tasks = this.filteredTasks(project, scope)
      const taskIds = new Set(tasks.map(({ task }) => task.id))
      const taskChildren = new Map<string | null, Task[]>()
      for (const { task, parentId } of tasks) {
        const key = parentId && taskIds.has(parentId) ? parentId : null
        const items = taskChildren.get(key) ?? []
        items.push(task)
        taskChildren.set(key, items)
      }
      const taskBranch = async (task: Task, taskDepth: number): Promise<Row[]> => {
        const key = 'task:' + project.id + '|' + task.id
        const entry = {
          ...this.taskRow(project, task, true, scope.config.statuses),
          id: key,
          branchKey: key,
          depth: taskDepth
        }
        if (!this.expanded.has(key)) return [entry]
        const [subtasks, checks] = await Promise.all([
          Promise.all((taskChildren.get(task.id) ?? []).map((child) => taskBranch(child, taskDepth + 1))),
          this.checklistRows(task, key)
        ])
        return [entry, ...subtasks.flat(), ...checks.map((check) => ({ ...check, depth: taskDepth + 1 }))]
      }
      const taskRows = await Promise.all((taskChildren.get(null) ?? []).map((task) => taskBranch(task, depth + 1)))
      return [heading, ...subprojects.flat(), ...taskRows.flat()]
    }
    return (await Promise.all((projectChildren.get(null) ?? []).map((row) => projectBranch(row, 0)))).flat()
  }

  private async loadRows(path: string, taskId: string | undefined, projects: Row[], request: number): Promise<void> {
    const project = await this.plugin.store.loadProjectByPath(path)
    if (request !== this.request) return
    const ref = this.plugin.index.projectRef(path)
    if (!project || !ref) {
      this.navigate({})
      return
    }
    const task = taskId ? findTaskById(project, taskId) : null
    if (taskId && !task) {
      this.navigate({ project: path })
      return
    }
    if (!task) {
      const scope = new ProjectScope({ kind: 'project', path }, [project], this.plugin.store)
      const tasks = this.filteredTasks(project, scope)
      this.paint(
        projects,
        [
          this.projectRow(ref, 'project', false),
          ...tasks.map(({ task }) => this.taskRow(project, task, true, scope.config.statuses))
        ],
        project.title,
        undefined,
        tasks.length ? undefined : t('projectTimeline.noTasks')
      )
      return
    }
    const rows = await this.checklistRows(task, task.id)
    if (request !== this.request) return
    this.paint(
      projects,
      [this.taskRow(project, task, false, this.plugin.store.configFor(project).statuses), ...rows],
      project.title,
      task.title,
      rows.length ? undefined : t('projectTimeline.noChecklist')
    )
  }

  private paint(projects: Row[], rows: Row[], project?: string, task?: string, message?: string): void {
    const previousChart = this.host.querySelector<HTMLElement>('.pm-tl-chart')
    const previousChartRange = previousChart?.dataset.timelineRange
    const previousScrollLeft = previousChart?.scrollLeft ?? 0
    const previousFocus = this.host.doc.activeElement
    const focusKey =
      previousFocus instanceof HTMLElement && this.host.contains(previousFocus)
        ? previousFocus.dataset.timelineFocus
        : undefined
    this.host.empty()
    const surface = this.host.createDiv('pm-project-timeline')
    surface.dataset.mode = this.mode
    surface.dataset.layout = this.layout
    const header = surface.createEl('header', { cls: 'pm-tl-header' })
    const path = header.createEl('nav', { cls: 'pm-tl-path', attr: { 'aria-label': t('projectTimeline.path') } })
    this.renderPath(path, project, task)
    header.createEl('h2', { text: task ?? project ?? t('projectTimeline.overview') })
    const controls = header.createDiv('pm-tl-controls')
    const modesEl = controls.createDiv({
      cls: 'pm-tl-modes',
      attr: { role: 'group', 'aria-label': t('projectTimeline.display') }
    })
    for (const { id, label, hint } of modes) {
      const button = modesEl.createEl('button', {
        text: t(label),
        attr: { type: 'button', 'aria-pressed': String(id === this.mode), title: t(hint) }
      })
      button.dataset.timelineFocus = 'mode-' + id
      button.onclick = () => {
        this.mode = id
        this.paint(projects, rows, project, task, message)
      }
    }
    const todayDate = today()
    const current = timelineDay({ day: todayDate.toString() })
    const points: number[] = []
    for (const row of [...projects, ...rows]) {
      for (const dates of [row.plan, row.actual]) {
        if (dates.start) points.push(timelineDay(dates.start))
        if (dates.end) points.push(timelineDay(dates.end))
        if (dates.ongoing) points.push(current)
      }
    }
    const window =
      this.span === 'auto'
        ? undefined
        : timelineWindow(this.span, parsePlainDate(this.spanAnchors[this.span] ?? '') ?? todayDate, 0, todayDate)
    const [start, end] = window ? [window.start, window.end] : chartBounds(points, current)
    const position = (day: number) => ((day - start) / (end - start)) * 100
    const showToday = start <= current && current < end
    const repaint = () => this.paint(projects, rows, project, task, message)
    this.renderSpanControls(controls, repaint, window)
    if (this.mode === 'compare') {
      const legend = controls.createDiv('pm-tl-legend')
      legend.createSpan({ cls: 'pm-tl-key-plan', text: t('projectTimeline.plan') })
      legend.createSpan({ cls: 'pm-tl-key-actual', text: t('projectTimeline.actual') })
    }
    if (showToday) {
      controls.createSpan({
        cls: 'pm-tl-today-label',
        text: t('gantt.today') + ' ' + formatDateShort(axisDate(current))
      })
    }
    const daily = this.span === 'around7' || this.span === 'around14'
    const dayNavigation = this.span === 'around7' && window ? surface.createDiv('pm-tl-day-navigation') : undefined
    const shiftDay = (offset: number) => {
      if (!window) return
      const focus = window.focus.add({ days: offset })
      this.rememberSpan('around7', focus.equals(today()) ? null : focus.toString())
      repaint()
    }
    const chart = daily ? (dayNavigation ?? surface).createDiv('pm-tl-chart') : surface
    if (dayNavigation) this.renderDayArrow(dayNavigation, 'next', () => shiftDay(1))
    if (daily) {
      chart.dataset.timelineRange = start + ':' + end
      chart.style.setProperty('--pm-tl-day-count', String(end - start))
    }
    const axis = chart.createDiv('pm-tl-row pm-tl-axis')
    const axisLabel = axis.createDiv({
      cls: 'pm-tl-label',
      text: t(task ? 'projectTimeline.checklist' : project ? 'projectTimeline.tasks' : 'projectTimeline.projects')
    })
    if (dayNavigation) this.renderDayArrow(axisLabel, 'previous', () => shiftDay(-1))
    const scale = axis.createDiv('pm-tl-scale')
    const ticks = window?.ticks ?? Array.from({ length: 6 }, (_, tick) => start + ((end - start) * tick) / 6)
    const dayFormat = daily
      ? new Intl.DateTimeFormat(locale(), {
          month: 'numeric',
          day: 'numeric',
          timeZone: 'UTC'
        })
      : undefined
    const lines: string[] = []
    for (const [index, tick] of ticks.entries()) {
      const left = position(tick)
      const date = axisDate(tick)
      const text = dayFormat
        ? dayFormat.format(new Date(date + 'T00:00:00Z'))
        : this.span === 'year'
          ? monthLabel(date)
          : formatDateShort(date)
      const label = scale.createSpan({ text, attr: { title: date } })
      if (tick === current) label.setAttribute('aria-current', 'date')
      label.style.left = left + '%'
      label.style.width = position(ticks[index + 1] ?? end) - left + '%'
      if (index) {
        lines.push(
          'transparent calc(' +
            left +
            '% - 1px), var(--background-modifier-border) calc(' +
            left +
            '% - 1px) ' +
            left +
            '%, transparent ' +
            left +
            '%'
        )
      }
    }
    if (lines.length) {
      surface.style.setProperty('--pm-tl-grid', 'linear-gradient(to right, transparent 0%, ' + lines.join(', ') + ')')
    }
    for (const row of rows) this.renderRow(chart, row, position, current, showToday, [start, end], surface)
    if (daily && (previousChartRange === chart.dataset.timelineRange || focusKey?.startsWith('day-'))) {
      chart.scrollLeft = previousScrollLeft
    }
    if (message) surface.createDiv({ cls: 'pm-tl-detail', text: message, attr: { role: 'status' } })
    const selection = rows.find((row) => row.id === this.selected)
    if (selection) this.renderDetail(surface, selection)
    if (focusKey) {
      surface
        .findAll('[data-timeline-focus]')
        .find((el) => el.dataset.timelineFocus === focusKey)
        ?.focus({ preventScroll: true })
    }
  }

  private renderDayArrow(host: HTMLElement, direction: 'previous' | 'next', shift: () => void): void {
    const label = t(direction === 'previous' ? 'projectTimeline.span.previousDay' : 'projectTimeline.span.nextDay')
    const button = host.createEl('button', {
      cls: 'pm-tl-day-arrow',
      attr: { type: 'button', 'aria-label': label, title: label }
    })
    button.dataset.timelineFocus = 'day-' + direction
    setIcon(button, direction === 'previous' ? 'chevron-left' : 'chevron-right')
    button.onclick = shift
  }

  private renderSpanControls(
    controls: HTMLElement,
    repaint: () => void,
    window: ReturnType<typeof timelineWindow> | undefined
  ): void {
    const spanControls = controls.createDiv('pm-tl-span-controls')
    const select = spanControls.createEl('select', {
      attr: { 'aria-label': t('projectTimeline.span'), title: t('projectTimeline.span') }
    })
    select.dataset.timelineFocus = 'span'
    for (const span of spans) select.createEl('option', { value: span, text: t(`projectTimeline.span.${span}`) })
    select.value = this.span
    select.onchange = () => {
      this.rememberSpan(select.value as Span)
      repaint()
    }
    const span = this.span
    if (!window || span === 'auto') return
    const reset = spanControls.createEl('button', {
      cls: 'pm-tl-reset',
      text: t('projectTimeline.span.today'),
      attr: { type: 'button' }
    })
    reset.dataset.timelineFocus = 'span-today'
    reset.onclick = () => {
      this.rememberSpan(span, null)
      repaint()
    }
    for (const direction of ['previous', 'next'] as const) {
      const label = t(`projectTimeline.span.${direction}`)
      const button = spanControls.createEl('button', {
        attr: { type: 'button', 'aria-label': label, title: label }
      })
      setIcon(button, direction === 'previous' ? 'chevron-left' : 'chevron-right')
      button.dataset.timelineFocus = direction
      button.onclick = () => {
        const current = today()
        const next = timelineWindow(span, window.focus, direction === 'previous' ? -1 : 1, current)
        const isCurrent = next.focus.equals(timelineWindow(span, current).focus)
        this.rememberSpan(span, isCurrent ? null : next.focus.toString())
        repaint()
      }
    }
    spanControls.createSpan({
      cls: 'pm-tl-window',
      text: axisDate(window.start) + ' – ' + axisDate(window.end - 1),
      attr: { 'aria-live': 'polite' }
    })
  }

  private renderPath(path: HTMLElement, project?: string, task?: string): void {
    const projectPath = this.level.project
    if (!projectPath) return
    const back = path.createEl('button', {
      cls: 'pm-tl-back',
      attr: { type: 'button', 'aria-label': t('projectTimeline.back'), title: t('projectTimeline.back') }
    })
    setIcon(back, 'arrow-left')
    back.dataset.timelineFocus = 'back'
    back.onclick = () => this.navigate(this.level.task ? { project: projectPath } : {})
    path.createEl('button', { text: t('projectTimeline.root'), attr: { type: 'button' } }).onclick = () =>
      this.navigate({})
    path.createSpan({ text: '›', attr: { 'aria-hidden': 'true' } })
    if (task) {
      path.createEl('button', { text: project, attr: { type: 'button' } }).onclick = () =>
        this.navigate({ project: projectPath })
      path.createSpan({ text: '›', attr: { 'aria-hidden': 'true' } })
    }
    path.createSpan({ text: task ?? project, attr: { 'aria-current': 'page' } })
  }

  private renderRow(
    chart: HTMLElement,
    row: Row,
    position: (day: number) => number,
    current: number,
    showToday: boolean,
    bounds: [number, number],
    selectionHost: HTMLElement
  ): void {
    const element = chart.createDiv({ cls: ['pm-tl-row', 'pm-tl-' + row.kind] })
    element.toggleClass('is-selected', row.id === this.selected)
    const label = element.createDiv('pm-tl-label')
    if (row.depth !== undefined) label.style.setProperty('--pm-tl-depth', String(Math.min(row.depth, 6)))
    const button = label.createEl('button', { cls: 'pm-tl-row-button', attr: { type: 'button', title: row.title } })
    button.dataset.timelineFocus = row.id
    const icons = { project: 'folder', subproject: 'folder', task: 'file-text', checklist: 'list-checks' }
    setIcon(button.createSpan({ attr: { 'aria-hidden': 'true' } }), icons[row.kind])
    button.createSpan({ cls: 'pm-tl-name', text: row.title })
    if (this.layout === 'nested' && row.destination) {
      const key = row.branchKey ?? row.id
      const expanded = this.expanded.has(key)
      button.setAttribute('aria-expanded', String(expanded))
      setIcon(
        button.createSpan({ cls: 'pm-tl-next', attr: { 'aria-hidden': 'true' } }),
        expanded ? 'chevron-down' : 'chevron-right'
      )
      button.onclick = () => this.toggleBranch(key)
    } else if (row.destination) {
      setIcon(button.createSpan({ cls: 'pm-tl-next', attr: { 'aria-hidden': 'true' } }), 'chevron-right')
      const destination = row.destination
      button.onclick = () => this.navigate(destination)
    } else {
      button.setAttribute('aria-pressed', String(this.selected === row.id))
      button.onclick = () => {
        this.selected = this.selected === row.id ? undefined : row.id
        const labels = chart.findAll('.pm-tl-row-button[aria-pressed]')
        for (const control of labels) {
          const selected = control === button && this.selected === row.id
          control.setAttribute('aria-pressed', String(selected))
          control.closest('.pm-tl-row')?.toggleClass('is-selected', selected)
        }
        selectionHost.querySelector('.pm-tl-selection')?.remove()
        if (this.selected) this.renderDetail(selectionHost, row)
      }
    }
    const plot = element.createDiv({
      cls: 'pm-tl-plot',
      attr: { role: 'img', 'aria-label': this.dateSummary(row) }
    })
    if (showToday) plot.createDiv('pm-tl-today').style.left = position(current) + '%'
    if (this.mode !== 'actual') this.renderMark(plot, 'plan', row.plan, position, current, bounds)
    if (this.mode !== 'plan') this.renderMark(plot, 'actual', row.actual, position, current, bounds)
    if (!plot.querySelector('.pm-tl-mark')) plot.createSpan({ cls: 'pm-tl-undated', text: '—' })
  }

  private renderMark(
    plot: HTMLElement,
    type: 'plan' | 'actual',
    dates: TimelineDates,
    position: (day: number) => number,
    current: number,
    [first, last]: [number, number]
  ): void {
    const start = dates.start && timelineDay(dates.start)
    const end = dates.end
      ? timelineDay(dates.end)
      : dates.ongoing && start !== undefined
        ? Math.max(start, current)
        : undefined
    const range = start !== undefined && end !== undefined && start < end
    const origin = range ? start : (end ?? start)
    if (origin === undefined) return
    if (range ? end <= first || start >= last : origin < first || origin >= last) return
    const mark = plot.createSpan({ cls: ['pm-tl-mark', 'pm-tl-' + type] })
    mark.toggleClass('is-point', !range)
    mark.toggleClass('is-ongoing', range && !!dates.ongoing)
    mark.style.left = position(Math.max(first, origin)) + '%'
    if (range) mark.style.width = position(Math.min(end, last)) - position(Math.max(start, first)) + '%'
  }

  private dateSummary(row: Row): string {
    return (
      t('projectTimeline.plan') +
      ' ' +
      describeDates(row.plan, 'plan') +
      ' · ' +
      t('projectTimeline.actual') +
      ' ' +
      describeDates(row.actual, 'actual')
    )
  }

  private renderDetail(surface: HTMLElement, row: Row): void {
    const detail = surface.createDiv({ cls: 'pm-tl-detail pm-tl-selection', attr: { role: 'status' } })
    detail.createEl('strong', { text: row.title })
    detail.createSpan({ text: this.dateSummary(row) })
    if (row.status) detail.createSpan({ text: row.status })
  }
}

function monthLabel(date: string): string {
  return new Intl.DateTimeFormat(locale(), { month: 'short', timeZone: 'UTC' }).format(new Date(date + 'T00:00:00Z'))
}

function fullDate(value: AgendaDate): string {
  return value.day + (value.time ? ' ' + value.time : '')
}

function describeDates(dates: TimelineDates, type: 'plan' | 'actual'): string {
  const { start, end, ongoing, event } = dates
  if (start && end) return fullDate(start) + ' → ' + fullDate(end)
  if (start) return fullDate(start) + (ongoing ? ' → ' + t('projectTimeline.ongoing') : '')
  if (end) {
    const label =
      event === 'completion'
        ? t('projectTimeline.completed')
        : event === 'cancellation'
          ? t('projectTimeline.cancelled')
          : event === 'hold'
            ? t('projectTimeline.held')
            : type === 'plan'
              ? t('columns.due')
              : ''
    return [label, fullDate(end)].filter(Boolean).join(' ')
  }
  return '—'
}
