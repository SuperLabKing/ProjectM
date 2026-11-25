import { Menu } from 'obsidian'
import type PMPlugin from '#main'
import type { ProjectRef } from '#store'
import { t, type PMSettings } from '@dotpm/core'
import { safeAsync } from '@dotpm/ui'

export interface ProjectContextMenuOptions {
  plugin: PMPlugin
  openProject: (path: string, tab: PMSettings['projectTab']) => Promise<void>
  redraw: () => void
}

export function openProjectContextMenu(
  { plugin, openProject, redraw }: ProjectContextMenuOptions,
  ref: ProjectRef,
  e: MouseEvent
): void {
  e.preventDefault()
  const menu = new Menu()
  menu.addItem((item) =>
    item
      .setTitle(t('project.openInCurrentTab'))
      .setIcon('arrow-right')
      .onClick(safeAsync(() => openProject(ref.path, 'current')))
  )
  menu.addItem((item) =>
    item
      .setTitle(t('project.openInNewTab'))
      .setIcon('external-link')
      .onClick(safeAsync(() => openProject(ref.path, 'new')))
  )
  menu.addSeparator()
  menu.addItem((item) =>
    item
      .setTitle(t('project.openOverview'))
      .setIcon('file-text')
      .onClick(safeAsync(() => plugin.router.openProjectOverview(ref.path)))
  )
  menu.addItem((item) =>
    item
      .setTitle(t('project.openTasks'))
      .setIcon('table')
      .onClick(safeAsync(() => plugin.router.openProjectTasks(ref.path)))
  )
  menu.addItem((item) =>
    item
      .setTitle(t('commands.duplicateProject'))
      .setIcon('copy')
      .onClick(
        safeAsync(async () => {
          const project = await plugin.store.loadProjectByPath(ref.path)
          if (!project) return
          await plugin.duplicateProjectFlow(project)
        })
      )
  )
  menu.addItem((item) =>
    item
      .setTitle(t('project.edit'))
      .setIcon('settings')
      .onClick(safeAsync(() => plugin.router.openProjectEdit(ref.path)))
  )
  if (!plugin.index.isArchived(ref.path)) {
    menu.addItem((item) =>
      item
        .setTitle(t('project.archive'))
        .setIcon('archive')
        .onClick(safeAsync(() => plugin.setProjectArchived(ref.path, true)))
    )
  } else if (ref.archived) {
    menu.addItem((item) =>
      item
        .setTitle(t('project.unarchive'))
        .setIcon('archive-restore')
        .onClick(safeAsync(() => plugin.setProjectArchived(ref.path, false)))
    )
  }
  menu.addItem((item) =>
    item
      .setTitle(t('project.delete'))
      .setIcon('trash')
      .onClick(
        safeAsync(async () => {
          const project = await plugin.store.loadProjectByPath(ref.path)
          if (!project) return
          await plugin.store.deleteProject(project)
          redraw()
        })
      )
  )
  menu.showAtMouseEvent(e)
}
