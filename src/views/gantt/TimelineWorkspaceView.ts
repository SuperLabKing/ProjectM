import { setIcon } from 'obsidian'
import { t, type TaskQuery } from '@dotpm/core'
import type PMPlugin from '#main'
import type { ProjectScope } from '#store'
import type { SubView } from '../SubView'
import { ProjectTimelineView } from './ProjectTimelineView'
import { WorkHistoryView } from './WorkHistoryView'

type Pane = 'history' | 'schedule'

const panes = [
  { id: 'history', label: 'workHistory.title', icon: 'history' },
  { id: 'schedule', label: 'workHistory.schedule', icon: 'chart-gantt' }
] as const

export class TimelineWorkspaceView implements SubView {
  private readonly tabs: HTMLElement
  private readonly panels: Record<Pane, HTMLElement>
  private readonly views: Record<Pane, SubView>
  private active: Pane

  constructor(
    container: HTMLElement,
    scope: ProjectScope,
    plugin: PMPlugin,
    query: TaskQuery,
    editSchedule: () => void,
    startWithSchedule: boolean
  ) {
    this.active = startWithSchedule ? 'schedule' : 'history'
    this.tabs = container.createDiv({
      cls: 'pm-timeline-tabs',
      attr: { role: 'group', 'aria-label': t('views.gantt') }
    })
    for (const { id, label, icon } of panes) {
      const button = this.tabs.createEl('button', {
        attr: { type: 'button', 'data-timeline-pane': id }
      })
      setIcon(button.createSpan({ attr: { 'aria-hidden': 'true' } }), icon)
      button.createSpan({ text: t(label) })
      button.onclick = () => {
        if (id === this.active) return
        this.active = id
        this.render()
      }
    }
    const history = container.createDiv('pm-timeline-panel')
    const schedule = container.createDiv('pm-timeline-panel')
    this.panels = { history, schedule }
    schedule.createDiv('pm-timeline-edit').createEl('button', {
      text: t('projectTimeline.editSchedule'),
      attr: { type: 'button' }
    }).onclick = editSchedule
    this.views = {
      history: new WorkHistoryView(history, scope, plugin, query),
      schedule: new ProjectTimelineView(schedule.createDiv(), scope, plugin, query)
    }
  }

  render(): void {
    for (const { id } of panes) {
      const current = id === this.active
      this.panels[id].hidden = !current
      this.tabs.querySelector('[data-timeline-pane="' + id + '"]')?.setAttribute('aria-pressed', String(current))
    }
    this.views[this.active].render()
  }

  destroy(): void {
    for (const view of Object.values(this.views)) view.destroy?.()
  }
}
