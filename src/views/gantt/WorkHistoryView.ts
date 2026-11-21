import { setIcon } from 'obsidian'
import type PMPlugin from '#main'
import { personKeyer, ProjectScope } from '#store'
import {
  applyTaskFilterFlat,
  flattenTasks,
  formatDateShort,
  getStatusConfig,
  linkedTaskState,
  locale,
  t,
  today,
  type TaskQuery
} from '@dotpm/core'
import type { SubView } from '../SubView'
import { axisDate, timelineChecklist, timelineWindow } from './timelineDates'
import { historyDays, historyEvents, type HistoryEvent } from './workHistory'

const kindLabels = {
  start: 'workHistory.started',
  completion: 'projectTimeline.completed',
  cancellation: 'projectTimeline.cancelled',
  hold: 'projectTimeline.held',
  planStart: 'workHistory.plannedStart',
  planEnd: 'workHistory.plannedDue',
  planRange: 'projectTimeline.plan'
} as const

export class WorkHistoryView implements SubView {
  private events: HistoryEvent[] | undefined
  private failed = false
  private includePlans = false
  private projectRange: 'current' | 'all' = 'current'
  private offset = 0
  private request = 0
  private readonly expanded = new Set<string>()
  private readonly rangeLabel: HTMLElement
  private readonly log: HTMLElement

  constructor(
    host: HTMLElement,
    private scope: ProjectScope,
    private plugin: PMPlugin,
    private query: TaskQuery
  ) {
    const view = host.createDiv('pm-work-history')
    const controls = view.createDiv('pm-wh-toolbar')
    const period = controls.createDiv({
      cls: 'pm-wh-period',
      attr: { role: 'group', 'aria-label': t('projectTimeline.span') }
    })
    this.addPageButton(period, -1)
    this.rangeLabel = period.createSpan({ cls: 'pm-wh-window', attr: { 'aria-live': 'polite' } })
    this.addPageButton(period, 1)
    period.createEl('button', {
      text: t('projectTimeline.span.today'),
      attr: { type: 'button', 'data-wh-today': '' }
    }).onclick = () => {
      this.offset = 0
      this.paint()
    }
    const filters = controls.createDiv('pm-wh-filters')
    const projectRange = filters.createEl('select', {
      cls: 'pm-wh-project-range',
      attr: { 'aria-label': t('workHistory.projectRange') }
    })
    projectRange.createEl('option', {
      value: 'current',
      text: t(
        scope.spec.kind === 'project' || scope.spec.kind === 'subtree'
          ? 'header.projectTreeCurrentProject'
          : 'workHistory.currentScope'
      )
    })
    projectRange.createEl('option', { value: 'all', text: t('header.projectTreeAllProjects') })
    projectRange.onchange = () => {
      this.projectRange = projectRange.value === 'all' ? 'all' : 'current'
      this.events = undefined
      this.failed = false
      this.paint()
      void this.render()
    }
    const toggle = filters.createEl('label', { cls: 'pm-wh-plan-toggle' })
    const input = toggle.createEl('input', { type: 'checkbox' })
    toggle.createSpan({ text: t('workHistory.showPlan') })
    input.onchange = () => {
      this.includePlans = input.checked
      this.paint()
    }
    this.log = view.createDiv('pm-wh-log')
    this.paint()
  }

  destroy(): void {
    this.request++
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
      this.projectRange === 'all'
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
      const statuses = local.config.statuses
      const rows = applyTaskFilterFlat(
        flattenTasks(project.tasks),
        this.query,
        local.filterContext(personKeyer(this.plugin.app))
      )
      // Keep vault reads bounded even when a project contains many note bodies.
      for (let index = 0; index < rows.length && request === this.request; index += 12) {
        const batch = await Promise.all(
          rows.slice(index, index + 12).map(async ({ task }) => {
            await store.loadTaskBody(task)
            const status = getStatusConfig(statuses, task.status)
            return historyEvents({
              sourceKey: project.id + '|' + task.id,
              project: project.title,
              title: task.title,
              start: task.start,
              due: task.due,
              completed: status?.complete ? task.completed : '',
              cancelled: linkedTaskState(task.status, status) === 'cancel',
              checklist: timelineChecklist(task.description)
            })
          })
        )
        for (const events of batch) result.push(...events)
      }
    }
    return result
  }

  private addPageButton(period: HTMLElement, offset: -1 | 1): void {
    const label = t(offset < 0 ? 'projectTimeline.span.previous' : 'projectTimeline.span.next')
    const button = period.createEl('button', {
      attr: { type: 'button', 'aria-label': label, title: label, 'data-wh-step': String(offset) }
    })
    setIcon(button, offset < 0 ? 'chevron-left' : 'chevron-right')
    button.onclick = () => {
      this.offset += offset
      this.paint()
    }
  }

  private paint(): void {
    const current = today()
    const { start, end } = timelineWindow('around7', current, this.offset)
    const first = axisDate(start)
    const last = axisDate(end)
    this.rangeLabel.setText(formatDateShort(first) + ' – ' + formatDateShort(axisDate(end - 1)))
    this.log.empty()
    if (this.failed || !this.events) {
      this.empty(this.failed ? t('common.somethingWentWrong') : t('projectTimeline.loading'))
      return
    }
    const days = historyDays(this.events, first, last, this.includePlans)
    if (!days.size) this.empty(t(this.includePlans ? 'workHistory.empty' : 'workHistory.emptyActual'))
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
    if (event.planned) row.dataset.historyPlan = ''
    row.createSpan({ cls: 'pm-wh-time', text: eventTime(event) })
    const content = row.createDiv()
    const title = content.createDiv('pm-wh-title')
    title.createSpan({ cls: 'pm-wh-kind', text: t(kindLabels[event.kind]) })
    title.createSpan({ text: event.title })
    content.createSpan({ cls: 'pm-wh-source', text: [event.project, event.task].filter(Boolean).join(' / ') })
    if (!event.children?.length) return
    const key = event.day + '|' + event.sourceKey
    const details = content.createEl('details')
    details.open = this.expanded.has(key)
    const summary = details.createEl('summary', {
      text: t('workHistory.checklistCount', { count: event.children.length })
    })
    summary.onclick = () => {
      if (details.open) this.expanded.delete(key)
      else this.expanded.add(key)
    }
    const children = details.createEl('ul')
    for (const child of event.children) {
      const item = children.createEl('li')
      item.createSpan({ cls: 'pm-wh-time', text: eventTime(child) })
      item.createSpan({ text: child.title })
    }
  }
}

function eventTime(event: HistoryEvent): string {
  if (!event.time) return t('agenda.allDay')
  return event.endTime ? event.time + '–' + event.endTime : event.time
}
