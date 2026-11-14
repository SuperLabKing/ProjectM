import { Notice } from 'obsidian'
import { LINKED_ROW_PREFIX, t, type Project, type ProjectTaskGroup } from '@dotpm/core'
import type PMPlugin from '#main'

export function projectGroups(plugin: PMPlugin, project: Project): ProjectTaskGroup[] {
  return plugin.settings.projectTaskGroups[project.id] ?? []
}

export function groupRoot(project: Project, id: string): string | null {
  const notes = project.linkedNotes ?? []
  const visited = new Set<string>()
  while (!visited.has(id)) {
    visited.add(id)
    const task = project.taskIndex.get(id)
    const linked = notes.find((note) => LINKED_ROW_PREFIX + note.id === id)
    if (!task && !linked) return null
    const linkedParent = task?.parentId === null ? notes.find((note) => note.childTaskIds?.includes(id)) : undefined
    const parent = linked?.parentId ?? task?.parentId ?? (linkedParent ? LINKED_ROW_PREFIX + linkedParent.id : null)
    if (!parent || (!project.taskIndex.has(parent) && !notes.some((note) => LINKED_ROW_PREFIX + note.id === parent))) {
      return id
    }
    id = parent
  }
  return null
}

export function groupForRow(plugin: PMPlugin, project: Project, id: string): ProjectTaskGroup | undefined {
  const root = groupRoot(project, id)
  return root ? projectGroups(plugin, project).find((group) => group.members.includes(root)) : undefined
}

export async function saveProjectGroups(
  plugin: PMPlugin,
  project: Project,
  update: (groups: ProjectTaskGroup[]) => ProjectTaskGroup[]
): Promise<void> {
  const groups = plugin.settings.projectTaskGroups
  const previous = groups[project.id]
  const next = update(previous ?? [])
  groups[project.id] = next
  try {
    await plugin.saveSettings()
  } catch (error) {
    if (groups[project.id] === next) {
      if (previous) groups[project.id] = previous
      else Reflect.deleteProperty(groups, project.id)
    }
    new Notice(t('taskGroups.saveError'))
    throw error
  }
}

export function assignGroup(groups: ProjectTaskGroup[], ids: ReadonlySet<string>, groupId: string | null) {
  return groups.map((group) => {
    const members = group.members.filter((id) => !ids.has(id))
    return group.id === groupId ? { ...group, members: [...members, ...ids] } : { ...group, members }
  })
}
