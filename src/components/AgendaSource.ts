import type { TFile } from 'obsidian'
import type PMPlugin from '#main'
import { t } from '@dotpm/core'
import { agendaDate, readChecklistSchedule, type AgendaItem } from '../views/agendaEntries'

export class AgendaSource {
  private notes = new WeakMap<TFile, { path: string; mtime: number; items: ChecklistItem[] }>()

  constructor(private plugin: PMPlugin) {
    plugin.registerEvent(plugin.app.metadataCache.on('changed', (file) => this.notes.delete(file)))
  }

  async load(isCurrent = () => true, onTerminal?: (id: string) => void): Promise<AgendaItem[]> {
    const { app, index, settings } = this.plugin
    const items: AgendaItem[] = []
    const statusLabels = new Map(settings.statuses.map((status) => [status.id, status.label]))
    const archived = new Set<string>()
    const taskTitles = new Map<string, string>()
    const seen = new Set<string>()
    for (const project of index.projectRefs(true)) {
      const hidden = index.isArchived(project.path)
      if (hidden) archived.add(project.path)
      const complete = index.completeStatuses(project)
      for (const task of index.taskRefs(project.path)) {
        const reminderId = `task:${task.id}`
        if (hidden || task.archived) {
          archived.add(task.path)
          continue
        }
        taskTitles.set(task.path, task.title)
        if (complete.has(task.status)) {
          onTerminal?.(reminderId)
          continue
        }
        if (seen.has(task.id)) continue
        const start = agendaDate(task.start)
        const due = agendaDate(task.due)
        if (!start && !due) continue
        seen.add(task.id)
        items.push({
          reminderId,
          title: task.title,
          path: task.path,
          source: project.title,
          status: statusLabels.get(task.status) ?? task.status,
          statusTone: task.status === 'todo' ? 'todo' : task.status === 'in-progress' ? 'active' : undefined,
          start,
          due
        })
      }
    }
    const files = app.vault
      .getMarkdownFiles()
      .filter((file) => !archived.has(file.path) && !index.isExcluded(file.path))
    for (let i = 0; i < files.length && isCurrent(); i += 32) {
      const batch = await Promise.all(files.slice(i, i + 32).map((file) => this.noteSchedules(file)))
      for (const schedules of batch) {
        for (const schedule of schedules) {
          if (schedule.terminal) onTerminal?.(schedule.reminderId)
          else items.push({ ...schedule, source: taskTitles.get(schedule.path) ?? schedule.source })
        }
      }
    }
    return items
  }

  async findChecklistLine(file: TFile, reminderId: string): Promise<number | undefined> {
    return (await this.noteSchedules(file)).find((item) => item.reminderId === reminderId)?.line
  }

  private async noteSchedules(file: TFile): Promise<ChecklistItem[]> {
    const { path, stat } = file
    const cached = this.notes.get(file)
    if (cached?.path === path && cached.mtime === stat.mtime) return cached.items
    const positions = this.plugin.app.metadataCache
      .getFileCache(file)
      ?.listItems?.filter((item) => item.task !== undefined)
    if (!positions?.length) return []
    const mtime = stat.mtime
    let text: string
    try {
      text = await this.plugin.app.vault.cachedRead(file)
    } catch {
      return []
    }
    const lines = text.split(/\r?\n/)
    const items: ChecklistItem[] = []
    const occurrences = new Map<string, number>()
    for (const { id, position } of positions) {
      const line = position.start.line
      const schedule = readChecklistSchedule(lines[line] ?? '', true)
      if (!schedule) continue
      const { mark, title, start, due } = schedule
      const occurrence = occurrences.get(title) ?? 0
      occurrences.set(title, occurrence + 1)
      const terminal = mark === 'done' || mark === 'cancelled'
      const status = terminal
        ? ''
        : mark === 'active'
          ? t('status.inProgress')
          : mark === 'held'
            ? t('agenda.held')
            : t('status.todo')
      const reminderId = 'note:' + JSON.stringify(id ? [path, id] : [path, title, occurrence])
      items.push({
        title,
        start,
        due,
        reminderId,
        path,
        line,
        source: file.basename,
        status,
        statusTone: terminal ? undefined : mark,
        terminal
      })
    }
    if (file.path === path && file.stat.mtime === mtime) this.notes.set(file, { path, mtime, items })
    return items
  }
}

type ChecklistItem = AgendaItem & { terminal: boolean; line: number; reminderId: string }
