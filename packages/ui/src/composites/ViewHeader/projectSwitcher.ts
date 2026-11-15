import { createButton } from '#platform'
import { Checkbox } from '#primitives/Checkbox'
import { ChipButton } from '#primitives/ChipButton'
import { CollapseToggle } from '#primitives/CollapseToggle'
import { Popover } from '#primitives/Popover'
import { t, tn } from '@dotpm/core'
import { renderPopSearch } from '../popoverParts'
import { renderOptionRow } from '../properties/optionList'

export interface SwitcherProject {
  path: string
  title: string
  icon?: string
  color?: string
  /** The project it sits under, when that one is listed too. */
  parent?: string
  /** The folder heading its top-level project is listed under, '' for the vault root. */
  folder: string
  taskCount: number
}

/** One of the fixed scopes above the list, named after what it covers. */
export interface SwitcherPreset {
  label: string
  active: boolean
  onPick: () => void
}

export interface ProjectSwitcherProps {
  /** Every project, each parent before its children. */
  projects: SwitcherProject[]
  /** The paths in view, checked when it opens. */
  selected: string[]
  /** The project the view shows alone, marked as current. */
  current?: string
  presets: SwitcherPreset[]
  /** A name was clicked: that project alone. */
  onPick: (path: string) => void
  /** Enables multi-project selection and receives the checked paths. */
  onShow?: (paths: string[]) => void
  /** Changes the active scope directly when multi-selection is unavailable. */
  onScopeCheck?: (path: string) => void
}

/**
 * Which projects the view shows. Clicking a name goes to that project alone; a checkbox,
 * Space or a modifier-click adds it to the selection, which "Show N projects", Mod+Enter or
 * closing the panel applies. A parent's box covers its whole branch and shows as mixed
 * when only part of it is checked. Returns what closing should do: apply the selection
 * when it changed and holds anything, unless something else already ended the panel.
 */
export function renderProjectSwitcherPanel(
  parent: HTMLElement,
  props: ProjectSwitcherProps,
  close: () => void
): () => void {
  const byPath = new Map(props.projects.map((project) => [project.path, project]))
  const children = new Map<string, SwitcherProject[]>()
  for (const project of props.projects) {
    if (!project.parent || !byPath.has(project.parent)) continue
    const siblings = children.get(project.parent)
    if (siblings) siblings.push(project)
    else children.set(project.parent, [project])
  }
  const branch = (path: string): string[] => [
    path,
    ...(children.get(path) ?? []).flatMap((child) => branch(child.path))
  ]
  const parentOf = (path: string): string | undefined => {
    const up = byPath.get(path)?.parent
    return up && byPath.has(up) ? up : undefined
  }

  const selected = new Set(props.selected.filter((path) => byPath.has(path)))
  const onShow = props.onShow
  const before = [...selected]
  const expanded = new Set<string>()
  for (const path of [...selected, ...(props.current ? [props.current] : [])]) {
    for (let up = parentOf(path); up; up = parentOf(up)) expanded.add(up)
  }
  let ended = false
  const end = (): void => {
    ended = true
    close()
  }
  const show = (): void => {
    if (!selected.size) return
    ended = true
    onShow?.(ordered())
    close()
  }
  const ordered = (): string[] => [
    ...before.filter((path) => selected.has(path)),
    ...[...selected].filter((path) => !before.includes(path))
  ]

  const root = parent.createDiv('pm-switcher')
  const search = renderPopSearch(root, t(onShow ? 'header.findProject' : 'header.findProjectName'), () => renderList())
  const presets = root.createDiv('pm-switcher-presets')
  for (const preset of props.presets) {
    new ChipButton(presets)
      .setVariant('outline')
      .setLabel(preset.label)
      .setActive(preset.active)
      .onClick(() => {
        preset.onPick()
        end()
      })
  }
  const list = root.createDiv('pm-pop-list pm-switcher-list')
  const foot = onShow ? root.createDiv('pm-switcher-foot pm-pop-section') : undefined
  const summary = foot?.createSpan('pm-switcher-summary')
  const clear = foot
    ? new ChipButton(foot)
        .setVariant('flat')
        .setLabel(t('common.clear'))
        .onClick(() => {
          selected.clear()
          sync()
        })
    : undefined
  const showButton = foot ? createButton(foot).setCta().onClick(show) : undefined

  const boxes: { path: string; box: Checkbox }[] = []
  const sync = (): void => {
    for (const { path, box } of boxes) {
      const covered = branch(path).filter((member) => selected.has(member)).length
      const all = covered === branch(path).length
      box.setChecked(all).setIndeterminate(covered > 0 && !all)
    }
    const tasks = [...selected].reduce((sum, path) => sum + (byPath.get(path)?.taskCount ?? 0), 0)
    summary?.setText(tn('header.selectedSummary', selected.size, { tasks: tn('header.taskCount', tasks) }))
    clear?.setDisabled(!selected.size)
    showButton?.setButtonText(tn('header.showProjects', selected.size)).setDisabled(!selected.size)
  }
  const toggle = (path: string): void => {
    const members = branch(path)
    const all = members.every((member) => selected.has(member))
    for (const member of members) {
      if (all) selected.delete(member)
      else selected.add(member)
    }
    sync()
  }

  const renderRow = (project: SwitcherProject, depth: number, tree: boolean): void => {
    const line = list.createDiv({ cls: 'pm-switcher-line', attr: { 'data-path': project.path } })
    line.setCssProps({ '--pm-depth': String(depth) })
    if (onShow || props.onScopeCheck) {
      const box = new Checkbox(line).setAriaLabel(t('header.showProject', { title: project.title })).onChange(() => {
        if (onShow) toggle(project.path)
        else {
          props.onScopeCheck?.(project.path)
          end()
        }
      })
      boxes.push({ path: project.path, box })
    } else {
      const indicator = new Checkbox(line)
      indicator.el.disabled = true
      indicator.el.setAttribute('aria-hidden', 'true')
      boxes.push({ path: project.path, box: indicator })
    }
    const kids = tree ? (children.get(project.path) ?? []) : []
    const isOpen = expanded.has(project.path)
    if (kids.length) {
      new CollapseToggle(line, {
        collapsed: !isOpen,
        subject: t('collapse.subProjects'),
        onToggle: () => setExpanded(project.path, !isOpen)
      })
    } else {
      line.createSpan('pm-switcher-gap')
    }
    const row = renderOptionRow(line, {
      label: project.title,
      icon: project.icon,
      color: project.color,
      note: kids.length && !isOpen ? `+${branch(project.path).length - 1}` : String(project.taskCount),
      selected: project.path === props.current,
      onPick: (e) => {
        if (onShow && (e.ctrlKey || e.metaKey)) {
          toggle(project.path)
          return
        }
        if (project.path !== props.current) props.onPick(project.path)
        end()
      }
    })
    row.addClass('pm-switcher-row')
    if (!isOpen) return
    for (const child of kids) renderRow(child, depth + 1, true)
  }

  const renderList = (): void => {
    list.empty()
    boxes.length = 0
    const query = search.value.trim().toLowerCase()
    const shown = query
      ? props.projects.filter(
          (project) =>
            project.title.toLowerCase().includes(query) || (!!onShow && project.folder.toLowerCase().includes(query))
        )
      : props.projects.filter((project) => !parentOf(project.path))
    const folders = new Map<string, SwitcherProject[]>()
    for (const project of shown) {
      const group = folders.get(project.folder)
      if (group) group.push(project)
      else folders.set(project.folder, [project])
    }
    for (const [folder, projects] of folders) {
      list.createDiv({ cls: 'pm-pop-heading', text: folder || t('scope.vault') })
      for (const project of projects) renderRow(project, 0, !query)
    }
    if (!shown.length) list.createDiv({ cls: 'pm-pop-empty', text: t('header.noProjectMatch') })
    sync()
  }

  const setExpanded = (path: string, open: boolean): void => {
    if (open) expanded.add(path)
    else expanded.delete(path)
    renderList()
    list.find(`[data-path="${CSS.escape(path)}"] button.pm-switcher-row`)?.focus()
  }

  const rows = (): HTMLButtonElement[] => list.findAll('button.pm-switcher-row') as HTMLButtonElement[]
  root.addEventListener('keydown', (e) => {
    if (onShow && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      show()
      return
    }
    const all = rows()
    const at = all.indexOf(e.target as HTMLButtonElement)
    if (e.target === search && e.key === 'ArrowDown') {
      e.preventDefault()
      all[0]?.focus()
      return
    }
    if (at === -1) return
    const path = all[at].closest<HTMLElement>('.pm-switcher-line')?.dataset.path
    if (!path) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = at + (e.key === 'ArrowDown' ? 1 : -1)
      if (next < 0) search.focus()
      else all[Math.min(next, all.length - 1)].focus()
    } else if (onShow && e.key === ' ') {
      e.preventDefault()
      toggle(path)
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !search.value.trim() && children.has(path)) {
      e.preventDefault()
      const open = e.key === 'ArrowRight'
      if (open !== expanded.has(path)) setExpanded(path, open)
    }
  })

  renderList()
  return () => {
    if (!onShow || ended || !selected.size) return
    if (selected.size === before.length && before.every((path) => selected.has(path))) return
    onShow(ordered())
  }
}

/** The switcher in a popover under `anchor`, with its search field focused. Escape discards the selection. */
export function openProjectSwitcher(anchor: HTMLElement, props: ProjectSwitcherProps): Popover {
  let applyOnClose = (): void => {}
  const onClose = (escaped: boolean): void => {
    if (!escaped) applyOnClose()
  }
  const pop = Popover.show({ anchor, width: 320, onClose }, (el, close) => {
    applyOnClose = renderProjectSwitcherPanel(el, props, close)
  })
  pop.contentEl.find('input.pm-pop-field')?.focus()
  return pop
}
