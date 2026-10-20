import { formatDate, toDateKey } from './format.js'

/** Presentation for tasks: labels, tones and how a due date reads. */

export const TASK_STATUS_LABELS = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
}

/** Status pill tones, reusing the shared pill palette. */
export const TASK_STATUS_TONES = {
  TODO: 'info',
  IN_PROGRESS: 'violet',
  DONE: 'success',
  CANCELLED: 'neutral',
}

export const TASK_PRIORITY_LABELS = {
  LOW: 'Low',
  NORMAL: 'Normal',
  HIGH: 'High',
  URGENT: 'Urgent',
}

export const TASK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT']

const DAY_MS = 24 * 60 * 60 * 1000

function daysBetween(fromKey, toKey) {
  const [fy, fm, fd] = fromKey.split('-').map(Number)
  const [ty, tm, td] = toKey.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS)
}

/**
 * How a due date reads next to a task: "Today", "Tomorrow", "3 days late",
 * "Fri, 20 Nov". `tone` is 'danger' for late open work, 'warning' for today.
 * Finished and cancelled tasks just show the date.
 */
export function describeDue(dueDate, status, today = new Date()) {
  if (!dueDate) return { label: 'No due date', tone: 'muted' }
  const open = status === 'TODO' || status === 'IN_PROGRESS'
  const days = daysBetween(toDateKey(today), dueDate)
  const date = formatDate(dueDate, { weekday: 'short', year: days > 300 || days < -300 ? 'numeric' : undefined })
  if (!open) return { label: date, tone: 'muted' }
  if (days < 0) return { label: days === -1 ? '1 day late' : `${-days} days late`, tone: 'danger', title: date }
  if (days === 0) return { label: 'Today', tone: 'warning', title: date }
  if (days === 1) return { label: 'Tomorrow', tone: 'default', title: date }
  return { label: date, tone: 'default' }
}

/**
 * The lists each person can switch between. Everyone has their own; a manager
 * also sees their team's; HR and administrators see everyone's.
 */
export function taskViewsFor(session) {
  const views = []
  if (session.employee) views.push({ value: 'mine', label: 'Assigned to me' })
  views.push({ value: 'created', label: 'Assigned by me' })
  if (session.employee && (session.isManager || session.isManagement)) views.push({ value: 'team', label: 'My team' })
  if (session.isManagement) views.push({ value: 'all', label: 'Everyone' })
  return views
}

export const TASK_STATUS_FILTERS = [
  { value: 'open', label: 'Open' },
  { value: 'TODO', label: 'To do' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'DONE', label: 'Done' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'all', label: 'All' },
]
