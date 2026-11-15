import type PMPlugin from '#main'
import type { TreeDrop } from './TreeRowDrag'

/** Undefined means invalid; null is the top level. */
export function projectDropParent(
  plugin: PMPlugin,
  sources: readonly string[],
  target: string,
  position: TreeDrop
): string | null | undefined {
  const { index } = plugin
  if (!index.projectRef(target)) return undefined
  const ancestors = index.ancestorRefs(target)
  if (sources.some((source) => source === target || ancestors.some((ref) => ref.path === source))) return undefined
  return position === 'inside' ? target : (index.parentOf(target)?.path ?? null)
}

export async function moveProjectRows(
  plugin: PMPlugin,
  sources: string[],
  target: string,
  position: TreeDrop,
  redrawDashboard = true
): Promise<boolean> {
  const { index, settings, store } = plugin
  const parent = projectDropParent(plugin, sources, target, position)
  if (parent === undefined) return false
  const projects = await Promise.all(sources.map((source) => store.loadProjectByPath(source)))
  const moving = projects.flatMap((project) => project ?? [])
  if (moving.length !== sources.length) return false
  const sourcePaths = new Set(sources)
  const refs = parent ? index.childRefs(parent, true) : index.rootRefs(true)
  const siblings = index.orderedProjectRefs(refs).filter((ref) => !sourcePaths.has(ref.path))
  const targetIndex = siblings.findIndex((ref) => ref.path === target)
  const insertion = targetIndex < 0 ? siblings.length : targetIndex + Number(position === 'after')
  const ids = siblings.map((ref) => ref.id)
  if (!(await store.moveProjects(moving, parent))) return false
  ids.splice(insertion, 0, ...moving.map((project) => project.id))
  if (parent) settings.collapsedProjects = settings.collapsedProjects.filter((path) => path !== parent)
  await plugin.saveProjectSiblingOrder(ids, redrawDashboard)
  return true
}
