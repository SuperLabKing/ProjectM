import type { LinkedNote, Project, StatusConfig, Task, TaskStatus } from '../types'

export const LINKED_NOTES_KEY = 'projectm-linked-notes'
export const LINKED_ROLLUPS_KEY = 'projectm-linked-rollups'
export const LINKED_ROW_PREFIX = 'projectm-link:'

export function readLinkedNotes(value: unknown): LinkedNote[] {
  if (!Array.isArray(value)) return []
  const records: LinkedNote[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const { id, note, parentId, status, beforeTaskId, childTaskIds } = item as Partial<LinkedNote>
    if (typeof id !== 'string' || !id || seen.has(id) || typeof note !== 'string' || !/^\[\[[^\r\n]+\]\]$/.test(note)) {
      continue
    }
    records.push({
      id,
      note,
      parentId: typeof parentId === 'string' && parentId ? parentId : null,
      status: typeof status === 'string' && status ? status : 'todo',
      ...(typeof beforeTaskId === 'string' && beforeTaskId ? { beforeTaskId } : {}),
      ...(Array.isArray(childTaskIds) ? { childTaskIds: childTaskIds.filter((id) => typeof id === 'string') } : {})
    })
    seen.add(id)
  }
  return records
}

export function readLinkedRollups(value: unknown): Record<string, TaskStatus> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

export interface TaskRowPlacement {
  movedIds: string[]
  parentId: string | null
  changesParent: boolean
  taskIds: string[]
  beforeTaskId?: string
  notes?: LinkedNote[]
}

const linkedRowId = (note: LinkedNote): string => LINKED_ROW_PREFIX + note.id

/** Plan the move in display order, pruning selected descendants of selected parents. */
export function planTaskRowMove(
  project: Project,
  selected: string[],
  target: string | null,
  position: 'before' | 'inside' | 'after'
): TaskRowPlacement | null {
  const notes = project.linkedNotes ?? []
  const linked = new Map(notes.map((note) => [linkedRowId(note), note]))
  const linkedParents = new Map<string, string>()
  for (const note of notes) {
    for (const id of note.childTaskIds ?? []) {
      if (project.taskIndex.get(id)?.parentId === null && !linkedParents.has(id)) {
        linkedParents.set(id, linkedRowId(note))
      }
    }
  }
  const parentOf = (id: string): string | null => {
    const parent = linked.get(id)?.parentId ?? linkedParents.get(id) ?? project.taskIndex.get(id)?.parentId
    return parent && (project.taskIndex.has(parent) || linked.has(parent)) ? parent : null
  }
  const siblings = (parent: string | null): string[] => {
    const tasks =
      parent && linked.has(parent)
        ? (linked.get(parent)?.childTaskIds ?? []).filter((id) => linkedParents.get(id) === parent)
        : (parent ? (project.taskIndex.get(parent)?.task.subtasks ?? []) : project.tasks)
            .map((task) => task.id)
            .filter((id) => parentOf(id) === parent)
    const associations = notes.filter((note) => parentOf(linkedRowId(note)) === parent)
    const anchors = new Set(tasks)
    const buckets = new Map<string | undefined, string[]>()
    for (const note of associations) {
      const anchor = note.beforeTaskId && anchors.has(note.beforeTaskId) ? note.beforeTaskId : undefined
      const bucket = buckets.get(anchor) ?? []
      bucket.push(linkedRowId(note))
      buckets.set(anchor, bucket)
    }
    return [...tasks.flatMap((id) => [...(buckets.get(id) ?? []), id]), ...(buckets.get(undefined) ?? [])]
  }
  if (target === null ? position !== 'inside' : !project.taskIndex.has(target) && !linked.has(target)) return null
  const parentId = position === 'inside' || target === null ? target : parentOf(target)
  const selectedSet = new Set(selected)
  const moving: string[] = []
  const visited = new Set<string>()
  const visit = (parent: string | null): void => {
    for (const id of siblings(parent)) {
      if (visited.has(id)) continue
      visited.add(id)
      if (selectedSet.has(id)) moving.push(id)
      else visit(id)
    }
  }
  visit(null)
  if (!moving.length || (target !== null && selectedSet.has(target))) return null
  const movingSet = new Set(moving)
  const ancestors = new Set(movingSet)
  for (let id: string | null = target; id; id = parentOf(id)) {
    if (ancestors.has(id)) return null
    ancestors.add(id)
  }
  const destination = siblings(parentId).filter((id) => !movingSet.has(id))
  const at =
    position === 'inside' || target === null
      ? destination.length
      : destination.indexOf(target) + Number(position === 'after')
  destination.splice(at, 0, ...moving)
  const taskIds = moving.filter((id) => !linked.has(id))
  const changesParent = moving.some((id) => parentOf(id) !== parentId)
  const nativeParent = parentId && linked.has(parentId) ? null : parentId
  const beforeTaskId =
    nativeParent === parentId ? destination.slice(at + moving.length).find((id) => !linked.has(id)) : undefined
  if (!notes.length) return { movedIds: moving, parentId, changesParent, taskIds, beforeTaskId }
  const updated: LinkedNote[] = []
  const childOrders = new Map<string, string[]>()
  function saveSiblings(rows: string[], parent: string | null): void {
    if (parent && linked.has(parent)) {
      childOrders.set(
        parent,
        rows.filter((id) => !linked.has(id))
      )
    }
    let anchor: string | undefined
    for (const id of [...rows].reverse()) {
      const note = linked.get(id)
      if (note) updated.push({ ...note, parentId: parent, beforeTaskId: anchor })
      else anchor = id
    }
  }
  const destinationNotes = destination.flatMap((id) => linked.get(id)?.note ?? [])
  if (new Set(destinationNotes).size !== destinationNotes.length) return null
  const affected = new Set([parentId, ...moving.map(parentOf)])
  saveSiblings(destination, parentId)
  for (const parent of affected) {
    if (parent !== parentId) {
      saveSiblings(
        siblings(parent).filter((id) => !movingSet.has(id)),
        parent
      )
    }
  }
  const unaffected = notes.filter((note) => !affected.has(parentOf(linkedRowId(note))))
  const reordered = [...unaffected, ...updated.reverse()].map((note) => {
    const childTaskIds = childOrders.get(linkedRowId(note))
    return childTaskIds ? { ...note, childTaskIds } : note
  })
  return { movedIds: moving, parentId, changesParent, taskIds, beforeTaskId, notes: reordered }
}

type State = 'todo' | 'start' | 'hold' | 'done' | 'cancel'

export function linkedTaskState(id: TaskStatus, status?: StatusConfig): State {
  const label = status?.label ?? ''
  if (/^cancel(?:led|ed)?$/i.test(id) || /取消/.test(label)) return 'cancel'
  if (/^(blocked|hold|paused)$/i.test(id) || /搁置|暂停/.test(label)) return 'hold'
  if (status?.complete || id === 'done') return 'done'
  if (/^(in-progress|doing|start|review)$/i.test(id) || /进行中/.test(label)) return 'start'
  return 'todo'
}

function parentState(states: Set<State>): State {
  if (states.size === 1) return states.values().next().value ?? 'todo'
  return states.size === 2 && states.has('todo') && states.has('cancel') ? 'todo' : 'start'
}

/** Reconcile from the deepest managed parent upward, so each ancestor sees the new child status. */
export function reconcileLinkedParents(
  project: Project,
  statuses: StatusConfig[],
  apply: (task: Task, patch: Pick<Task, 'status' | 'progress'>) => void
): void {
  const prior = project.linkedRollups ?? {}
  if (!project.linkedNotes?.length && !Object.keys(prior).length) return
  const notesByParent = new Map<string, LinkedNote[]>()
  const managed = new Set<string>()
  for (const note of project.linkedNotes ?? []) {
    if (!note.parentId || !project.taskIndex.has(note.parentId)) continue
    const siblings = notesByParent.get(note.parentId) ?? []
    siblings.push(note)
    notesByParent.set(note.parentId, siblings)
    for (let id: string | null = note.parentId; id && !managed.has(id);) {
      managed.add(id)
      id = project.taskIndex.get(id)?.parentId ?? null
    }
  }
  const definitions = new Map(statuses.map((status) => [status.id, status]))
  const stateOf = (id: TaskStatus) => linkedTaskState(id, definitions.get(id))
  const next: Record<string, TaskStatus> = Object.create(null)
  function visit(task: Task): void {
    for (const child of task.subtasks) visit(child)
    if (!managed.has(task.id) && !Object.hasOwn(prior, task.id)) return
    const states = [...task.subtasks, ...(notesByParent.get(task.id) ?? [])].map((child) => stateOf(child.status))
    if (!states.length) return
    const current = stateOf(task.status)
    const override = (current === 'hold' || current === 'cancel') && prior[task.id] !== task.status
    const target = parentState(new Set(states))
    const status =
      override || current === target
        ? task.status
        : (statuses.find((entry) => stateOf(entry.id) === target)?.id ?? task.status)
    const resulting = stateOf(status)
    if (managed.has(task.id)) {
      next[task.id] = !override && (resulting === 'hold' || resulting === 'cancel') ? status : ''
    }
    const progress = Math.round(
      (states.filter((state) => state === 'done' || state === 'cancel').length * 100) / states.length
    )
    if (status !== task.status || progress !== task.progress) apply(task, { status, progress })
  }
  for (const task of project.tasks) visit(task)
  project.linkedRollups = next
}
