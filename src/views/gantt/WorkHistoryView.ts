import { setIcon, setTooltip } from 'obsidian'
import type PMPlugin from '#main'
import { personKeyer, ProjectScope } from '#store'
import {
  applyTaskFilterFlat,
  flattenTasks,
  formatDateShort,
  locale,
  t,
  Temporal,
  today,
  type TaskQuery
} from '@dotpm/core'
import { safeAsync, type Popover } from '@dotpm/ui'
import { openAgendaItem } from '../../ui/agendaNavigation'
import type { SubView } from '../SubView'
import { openWorkHistoryCalendar } from './WorkHistoryCalendar'
import { timelineChecklist, timelineNoteChecklist } from './timelineDates'
import {
  checklistHistoryEvents,
  historyDays,
  workHistoryKinds,
  workHistoryStatusColor,
  type ChecklistTarget,
  type HistoryEvent,
  type HistorySource
} from './workHistory'

const sourceIcons = {
  project: { icon: 'layers', label: 'common.project' },
  subproject: { icon: 'git-branch', label: 'workHistory.subproject' },
  task: { icon: 'clipboard-list', label: 'common.task' },
  subtask: { icon: 'list-checks', label: 'workHistory.subtask' }
} as const

function statusIconInk(background: string): string {
  const channels = [1, 3, 5].map((start) => parseInt(background.slice(start, start + 2), 16) / 255)
  const [red, green, blue] = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  )
  // White needs 3:1 contrast against the fill for the small status glyph.
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
  return luminance <= 0.3 ? '#fff' : '#222'
}

function weekStart(date: Temporal.PlainDate): Temporal.PlainDate {
  return date.subtract({ days: date.dayOfWeek - 1 })
}

export class WorkHistoryView implements SubView {
  private events: HistoryEvent[] | undefined
  private failed = false
  private request = 0
  private readonly rangeLabel: HTMLElement
  private readonly log: HTMLElement
  private readonly renderedRows = new Map<HistoryEvent, HTMLElement>()
  private calendar?: Popover
  private selectedDate?: Temporal.PlainDate
  private highlightedElement?: HTMLElement
  private highlightTimer?: number

  constructor(
    host: HTMLElement,
    private scope: ProjectScope,
    private plugin: PMPlugin,
    private query: TaskQuery,
    public weekOffset = 0
  ) {
    const view = host.createDiv('pm-work-history')
    const controls = view.createDiv('pm-wh-toolbar')
    const period = controls.createDiv({
      cls: 'pm-wh-period',
      attr: { role: 'group', 'aria-label': t('projectTimeline.span') }
    })
    this.addPageButton(period, -1)
    const calendarButton = period.createEl('button', {
      cls: 'pm-wh-date-trigger',
      attr: { type: 'button', 'aria-expanded': 'false', 'aria-haspopup': 'dialog', 'aria-label': t('workHistory.pickDate') }
    })
    setIcon(calendarButton.createSpan({ attr: { 'aria-hidden': 'true' } }), 'calendar-days')
    this.rangeLabel = calendarButton.createSpan({ cls: 'pm-wh-window', attr: { 'aria-live': 'polite' } })
    calendarButton.onclick = () => this.toggleCalendar(calendarButton)
    this.addPageButton(period, 1)
    period.createEl('button', {
      text: t('projectTimeline.span.today'),
      attr: { type: 'button', 'data-wh-today': '' }
    }).onclick = () => {
      this.weekOffset = 0
      this.paint()
    }
    this.log = view.createDiv('pm-wh-log')
    this.paint()
  }

  destroy(): void {
    this.request++
    this.calendar?.close()
    this.clearHighlight()
  }

  async render(): Promise<void> {
    const request = ++this.request
    try {
      const records = await this.loadEvents(request)
      if (request !== this.request) return
      this.events = records
      this.failed = false
    } catch (error) {
      if (request !== this.request) return
      console.error('[PM] Work history', error)
      this.failed = true
    }
    this.paint()
  }

  private async loadEvents(request: number): Promise<HistoryEvent[]> {
    const { index, store } = this.plugin
    const scope = this.scope
    const { spec } = scope
    const paths =
      spec.kind === 'vault'
        ? index.projectPaths(this.query.filter.showArchived)
        : spec.kind === 'project' || spec.kind === 'subtree'
          ? [
              spec.path,
              ...index
                .descendantRefs(spec.path, index.isArchived(spec.path) || this.query.filter.showArchived)
                .map((ref) => ref.path)
            ]
          : scope.projects.map((project) => project.filePath)
    const result: HistoryEvent[] = []
    for (const path of paths) {
      if (request !== this.request) break
      const project = scope.projects.find((item) => item.filePath === path) ?? (await store.loadProjectByPath(path))
      if (!project || request !== this.request) continue
      const local = new ProjectScope({ kind: 'project', path }, [project], store)
      const projectSource: HistorySource[] = index.ancestorRefs(path).map(({ title }, i) => ({
        title,
        level: i === 0 ? 'project' : 'subproject'
      }))
      projectSource.push({ title: project.title, level: projectSource.length ? 'subproject' : 'project' })
      const flattened = flattenTasks(project.tasks)
      const taskById = new Map(flattened.map((row) => [row.task.id, row]))
      const rows = applyTaskFilterFlat(flattened, this.query, local.filterContext(personKeyer(this.plugin.app)))
      // Keep vault reads bounded even when a project contains many note bodies.
      for (let index = 0; index < rows.length && request === this.request; index += 12) {
        const batch = await Promise.all(
          rows.slice(index, index + 12).map(async ({ task, parentId }) => {
            const ancestors: HistorySource[] = []
            for (let parent = parentId ? taskById.get(parentId) : undefined; parent;
                parent = parent.parentId ? taskById.get(parent.parentId) : undefined) {
              ancestors.unshift({ title: parent.task.title, level: parent.parentId ? 'subtask' : 'task' })
            }
            const source: HistorySource[] = [
              ...projectSource,
              ...ancestors,
              { title: task.title, level: parentId ? 'subtask' : 'task' }
            ]
            const { vault } = this.plugin.app
            const file = task.filePath ? vault.getFileByPath(task.filePath) : null
            const markdown = file ? await vault.cachedRead(file).catch(() => undefined) : undefined
            if (file && markdown !== undefined) {
              return checklistHistoryEvents(timelineNoteChecklist(markdown), source, { path: file.path, taskId: task.id })
            }
            await store.loadTaskBody(task)
            return checklistHistoryEvents(timelineChecklist(task.description), source)
          })
        )
        for (const events of batch) result.push(...events)
      }
    }
    return result
  }

  private addPageButton(period: HTMLElement, offset: -1 | 1): void {
    const label = t(offset < 0 ? 'workHistory.previousWeek' : 'workHistory.nextWeek')
    const button = period.createEl('button', {
      attr: { type: 'button', 'aria-label': label, title: label, 'data-wh-step': String(offset) }
    })
    setIcon(button, offset < 0 ? 'chevron-left' : 'chevron-right')
    button.onclick = () => {
      this.weekOffset += offset
      this.paint()
    }
  }

  private paint(): void {
    const current = today()
    const start = weekStart(current).add({ weeks: this.weekOffset })
    const end = start.add({ weeks: 1 })
    const first = start.toString()
    this.rangeLabel.setText(formatDateShort(first) + ' – ' + formatDateShort(end.subtract({ days: 1 }).toString()))
    this.clearHighlight()
    this.renderedRows.clear()
    this.log.empty()
    if (this.failed || !this.events) {
      this.empty(this.failed ? t('common.somethingWentWrong') : t('projectTimeline.loading'))
      return
    }
    const days = historyDays(this.events, first, end.toString())
    if (!days.size) this.empty(t('workHistory.emptyActual'))
    const weekday = new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' })
    for (const [day, events] of days) {
      const section = this.log.createEl('section', { cls: 'pm-wh-day', attr: { 'data-history-date': day } })
      const header = section.createEl('header')
      const heading = header.createEl('h3')
      heading.createEl('time', { text: formatDateShort(day), attr: { datetime: day } })
      if (day === current.toString()) heading.createSpan({ cls: 'pm-wh-today', text: t('gantt.today') })
      header.createSpan({ cls: 'pm-wh-weekday', text: weekday.format(new Date(day + 'T00:00:00Z')) })
      const list = section.createEl('ul', { cls: 'pm-wh-items' })
      for (const event of events) this.renderEvent(list, event)
    }
  }

  private empty(text: string): void {
    this.log.createDiv({ cls: 'pm-wh-empty', text, attr: { role: 'status' } })
  }

  private renderEvent(list: HTMLElement, event: HistoryEvent): void {
    const row = list.createEl('li', { cls: 'pm-wh-entry', attr: { 'data-history-kind': event.kind } })
    const target = event.target
    const time = row.createDiv('pm-wh-time')
    time.createSpan({ cls: 'pm-wh-time-value', text: event.time ?? t('workHistory.dateOnly') })
    if (event.crossDay) {
      const later = event.kind === 'start'
      const other = later ? event.crossDay.end : event.crossDay.start
      const kind = later ? event.crossDay.endKind : 'start'
      const date = [formatDateShort(other.day), other.time].filter(Boolean).join(' ')
      const label = t('workHistory.relatedEvent', { date, status: t(workHistoryKinds[kind].label) })
      const jump = time.createEl('button', {
        cls: 'pm-wh-related',
        attr: { type: 'button', 'aria-label': label }
      })
      setIcon(jump.createSpan({ attr: { 'aria-hidden': 'true' } }), later ? 'arrow-up-right' : 'arrow-down-left')
      setTooltip(jump, label)
      jump.onclick = () => this.jumpToRelated(event)
      this.renderedRows.set(event, row)
    }
    const body = row.createDiv('pm-wh-event-body')
    const kind = workHistoryKinds[event.kind]
    const status = t(kind.label)
    const badge = body.createSpan({ cls: 'pm-wh-kind', attr: { role: 'img', 'aria-label': status } })
    const fill = workHistoryStatusColor(this.plugin.settings.workHistoryStatusColors, event.kind)
    badge.style.backgroundColor = fill
    badge.style.color = statusIconInk(fill)
    setIcon(badge, kind.icon)
    setTooltip(badge, status)
    const content = body.createDiv()
    const title = content.createDiv('pm-wh-title')
    if (target) {
      const open = title.createEl('button', {
        cls: 'pm-wh-text-button',
        text: event.title,
        attr: { type: 'button' }
      })
      setTooltip(open, t('workHistory.openChecklist'))
      open.onclick = safeAsync(() => this.openChecklist(target))
    } else title.setText(event.title)
    this.renderSource(content, event.source)
    if (event.sameDayStart) {
      const time = event.sameDayStart.time ?? t('workHistory.dateOnly')
      content.createDiv({ cls: 'pm-wh-start-time', text: t('workHistory.startedAt', { time }) })
    }
  }

  private toggleCalendar(anchor: HTMLElement): void {
    if (this.calendar?.isOpen) {
      this.calendar.close()
      return
    }
    const current = today()
    const first = weekStart(current).add({ weeks: this.weekOffset })
    const selected = this.selectedDate && weekStart(this.selectedDate).equals(first)
      ? this.selectedDate
      : this.weekOffset === 0 ? current : first
    const days = new Set(this.events?.map((event) => event.day))
    this.calendar = openWorkHistoryCalendar(anchor, selected, days, (day) => this.jumpToDate(day), () => {
      this.calendar = undefined
    })
  }

  private jumpToDate(day: Temporal.PlainDate): void {
    this.selectedDate = day
    this.showWeekOf(day)
    const date = day.toString()
    const section = this.log.querySelector<HTMLElement>(`[data-history-date="${date}"]`)
    if (section) this.highlight(section, 'start')
    else if (this.events && !this.failed) this.plugin.showNotice(t('workHistory.noRecordsOnDate', { date: formatDateShort(date) }))
  }

  private showWeekOf(day: Temporal.PlainDate): void {
    const offset = weekStart(today()).until(weekStart(day), { largestUnit: 'weeks' }).weeks
    if (offset === this.weekOffset) return
    this.weekOffset = offset
    this.paint()
  }

  private jumpToRelated(event: HistoryEvent): void {
    const related = this.events?.find((item) => item !== event && item.crossDay === event.crossDay)
    if (!related) return
    this.showWeekOf(Temporal.PlainDate.from(related.day))
    const row = this.renderedRows.get(related)
    if (!row) return
    this.highlight(row, 'center')
    row.querySelector<HTMLButtonElement>('.pm-wh-related')?.focus({ preventScroll: true })
  }

  private highlight(element: HTMLElement, block: ScrollLogicalPosition): void {
    this.clearHighlight()
    this.highlightedElement = element
    element.addClass('pm-wh-jump-target')
    const reduceMotion = element.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollIntoView({ block, behavior: reduceMotion ? 'instant' : 'smooth' })
    this.highlightTimer = window.setTimeout(() => this.clearHighlight(), 1400)
  }

  private clearHighlight(): void {
    window.clearTimeout(this.highlightTimer)
    this.highlightTimer = undefined
    this.highlightedElement?.removeClass('pm-wh-jump-target')
    this.highlightedElement = undefined
  }

  private async openChecklist(target: ChecklistTarget): Promise<void> {
    const { vault } = this.plugin.app
    const path = this.plugin.index.task(target.taskId)?.path ?? target.path
    const file = vault.getFileByPath(path)
    const markdown = file ? await vault.cachedRead(file).catch(() => undefined) : undefined
    if (markdown !== undefined) {
      const matches = timelineNoteChecklist(markdown).filter((entry) => entry.text === target.text)
      const entry = matches.find((entry) => entry.line === target.line) ?? (matches.length === 1 ? matches[0] : undefined)
      if (entry) {
        await openAgendaItem(this.plugin, { path, line: entry.line })
        return
      }
    }
    this.plugin.showNotice(t('agenda.itemMissing'))
  }
  private renderSource(parent: HTMLElement, path: readonly HistorySource[]): void {
    if (!path.length) return
    const source = parent.createDiv('pm-wh-source')
    for (const [i, step] of path.entries()) {
      const part = source.createSpan({ cls: 'pm-wh-source-part' })
      if (i) part.createSpan({ text: '›', attr: { 'aria-hidden': 'true' } })
      const { icon, label } = sourceIcons[step.level]
      const iconEl = part.createSpan({ cls: 'pm-wh-source-icon', attr: { role: 'img', 'aria-label': t(label) } })
      setIcon(iconEl, icon)
      setTooltip(iconEl, t(label))
      part.createSpan({ cls: 'pm-wh-source-name', text: step.title })
    }
  }
}
