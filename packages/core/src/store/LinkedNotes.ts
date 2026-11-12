import type { LinkedNote, Project, StatusConfig, Task, TaskStatus } from '../types'

export const LINKED_NOTES_KEY = 'projectm-linked-notes'
export const LINKED_ROLLUPS_KEY = 'projectm-linked-rollups'

export function readLinkedNotes(value: unknown): LinkedNote[] {
  if (!Array.isArray(value)) return []
  const records: LinkedNote[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const { id, note, parentId, status } = item as Partial<LinkedNote>
    if (typeof id !== 'string' || !id || seen.has(id) || typeof note !== 'string' || !/^\[\[[^\r\n]+\]\]$/.test(note)) {
      continue
    }
    records.push({
      id,
      note,
      parentId: typeof parentId === 'string' && parentId ? parentId : null,
      status: typeof status === 'string' && status ? status : 'todo'
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

type State = 'todo' | 'start' | 'hold' | 'done' | 'cancel'

function taskState(id: TaskStatus, status?: StatusConfig): State {
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
  const stateOf = (id: TaskStatus) => taskState(id, definitions.get(id))
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
