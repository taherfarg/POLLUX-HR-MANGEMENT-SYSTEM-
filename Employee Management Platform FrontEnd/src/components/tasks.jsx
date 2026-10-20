import { useEffect, useState } from 'react'
import { ArrowRight, Ban, CalendarDays, Check, CheckCircle2, Flag, MessageSquare, Pencil, RotateCcw, Send, Trash2, UserRound } from 'lucide-react'
import { Async, Avatar, ConfirmDialog, EmptyMini, ErrorState, FormError, FormField, LoadingState, Modal, Panel, RequestFact, Spinner, StatusPill, useSubmit } from './ui.jsx'
import { useResource } from '../hooks/useResource.js'
import { chatPerson } from '../lib/chat.js'
import { useChangeListener } from '../lib/events.js'
import { formatDate, relativeTime } from '../lib/format.js'
import { describeDue, TASK_PRIORITIES, TASK_PRIORITY_LABELS, TASK_STATUS_LABELS, TASK_STATUS_TONES } from '../lib/tasks.js'
import { addTaskComment, createTask, deleteTask, fetchTask, fetchTaskAssignees, fetchTasks, updateTask } from '../api/endpoints.js'

export function TaskStatus({ status }) {
  return <StatusPill tone={TASK_STATUS_TONES[status]} label={TASK_STATUS_LABELS[status]} />
}

export function PriorityFlag({ priority, quiet = false }) {
  if (quiet && (priority === 'NORMAL' || priority === 'LOW')) return null
  return (
    <span className={`priority priority-${priority.toLowerCase()}`}>
      <Flag size={13} aria-hidden="true" />
      {TASK_PRIORITY_LABELS[priority]}
    </span>
  )
}

export function DueDate({ task }) {
  const due = describeDue(task.dueDate, task.status)
  return (
    <span className={`due due-${due.tone}`} title={due.title}>
      {due.label}
    </span>
  )
}

/** The round tick in front of a task: done, or back to do. */
export function TaskCheck({ task, onToggle, busy }) {
  const done = task.status === 'DONE'
  if (!task.permissions.canProgress || task.status === 'CANCELLED') return <span className="task-check task-check-off" aria-hidden="true" />
  return (
    <button
      type="button"
      className={`task-check ${done ? 'task-check-done' : ''}`}
      aria-label={done ? `Reopen "${task.title}"` : `Mark "${task.title}" done`}
      aria-pressed={done}
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation()
        onToggle(task)
      }}
    >
      <Check size={13} strokeWidth={3} aria-hidden="true" />
    </button>
  )
}

/** New task, or editing one. Who it can go to comes from the API. */
export function TaskForm({ task, onCancel, onSaved }) {
  const editing = Boolean(task)
  const [values, setValues] = useState({
    title: task?.title ?? '',
    description: task?.description ?? '',
    assigneeId: task?.assignee.id ?? '',
    priority: task?.priority ?? 'NORMAL',
    dueDate: task?.dueDate ?? '',
  })
  const people = useResource(() => fetchTaskAssignees(), [])
  const options = people.data ?? []
  const choices = task && !options.some((person) => person.id === task.assignee.id) ? [{ ...task.assignee, isSelf: false }, ...options] : options

  // A person who can only give tasks to themselves gets no choice to make.
  useEffect(() => {
    if (!editing && !values.assigneeId && options.length) {
      const self = options.find((person) => person.isSelf) ?? options[0]
      setValues((current) => ({ ...current, assigneeId: self.id }))
    }
  }, [editing, options, values.assigneeId])

  const set = (field) => (event) => setValues((current) => ({ ...current, [field]: event.target.value }))

  const { submit, saving, error } = useSubmit(async () => {
    const payload = {
      title: values.title,
      description: editing ? values.description || null : values.description || undefined,
      priority: values.priority,
      dueDate: values.dueDate || (editing ? null : undefined),
      assigneeId: values.assigneeId || undefined,
    }
    const saved = editing ? await updateTask(task.id, payload) : await createTask(payload)
    onSaved(saved)
  })

  return (
    <form className="simple-form" onSubmit={submit}>
      <FormField label="Task" error={error?.fieldError?.('title')}>
        <input value={values.title} onChange={set('title')} placeholder="What needs doing?" maxLength={160} required autoFocus />
      </FormField>
      <FormField label="Details" hint="Optional - context, links, what done looks like." error={error?.fieldError?.('description')}>
        <textarea rows="4" value={values.description} onChange={set('description')} maxLength={4000} />
      </FormField>
      <div className="task-form-grid">
        <FormField label="For" error={error?.fieldError?.('assigneeId')}>
          <select value={values.assigneeId} onChange={set('assigneeId')} disabled={people.loading || choices.length <= 1} required>
            {people.loading && <option value="">Loading…</option>}
            {choices.map((person) => (
              <option key={person.id} value={person.id}>
                {person.isSelf ? `Me (${person.fullName})` : `${person.fullName} · ${person.jobTitle}`}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Priority">
          <select value={values.priority} onChange={set('priority')}>
            {TASK_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {TASK_PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Due" error={error?.fieldError?.('dueDate')}>
          <input type="date" value={values.dueDate} onChange={set('dueDate')} />
        </FormField>
      </div>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving && <Spinner size={15} />} {editing ? 'Save changes' : 'Create task'}
        </button>
      </div>
    </form>
  )
}

/** The home page's short list: what is on my plate, soonest due first. */
export function MyTasksPanel({ navigate }) {
  const tasks = useResource(() => fetchTasks({ view: 'mine', status: 'open', pageSize: 5 }), [])
  useChangeListener('tasks', tasks.reload)
  const items = tasks.data?.items ?? []
  const open = (tasks.data?.summary?.todo ?? 0) + (tasks.data?.summary?.inProgress ?? 0)

  return (
    <Panel
      title="My tasks"
      description={open ? `${open} open${tasks.data?.summary?.overdue ? ` · ${tasks.data.summary.overdue} late` : ''}` : undefined}
      actions={
        <button className="button button-ghost button-sm" onClick={() => navigate('tasks')}>
          All tasks <ArrowRight size={15} />
        </button>
      }
    >
      <Async loading={tasks.loading} error={tasks.error} onRetry={tasks.reload} rows={2}>
        {items.length ? (
          <div className="list">
            {items.map((task) => (
              <button className="list-row" key={task.id} onClick={() => navigate('tasks', task.id)}>
                <div className="grow">
                  <strong className="truncate">{task.title}</strong>
                  <small>{task.createdBy && !task.permissions.canEdit ? `From ${task.createdBy.fullName}` : TASK_STATUS_LABELS[task.status]}</small>
                </div>
                <PriorityFlag priority={task.priority} quiet />
                <DueDate task={task} />
              </button>
            ))}
          </div>
        ) : (
          <EmptyMini icon={CheckCircle2} title="Nothing on your list" text="Tasks your manager or HR give you appear here." />
        )}
      </Async>
    </Panel>
  )
}

const PROGRESS = ['TODO', 'IN_PROGRESS', 'DONE']

/** One task: its details, moving it along, and the conversation about it. */
export function TaskDetail({ taskId, onClose, onChanged, onToast }) {
  const detail = useResource(() => fetchTask(taskId), [taskId], { enabled: Boolean(taskId) })
  const task = detail.data
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [comment, setComment] = useState('')

  useEffect(() => {
    setEditing(false)
    setError(null)
    setComment('')
  }, [taskId])

  const refresh = () => {
    detail.reload()
    onChanged?.()
  }

  const move = async (status) => {
    if (status === task.status) return
    setBusy(true)
    setError(null)
    try {
      await updateTask(task.id, { status })
      onToast(status === 'DONE' ? 'Task done.' : `Moved to ${TASK_STATUS_LABELS[status].toLowerCase()}.`)
      refresh()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  const sendComment = useSubmit(async () => {
    if (!comment.trim()) return
    await addTaskComment(task.id, comment.trim())
    setComment('')
    refresh()
  })

  if (!taskId) return null
  const assignee = task ? chatPerson({ id: task.assignee.id, fullName: task.assignee.fullName }) : null

  return (
    <>
      <Modal
        open={Boolean(taskId) && !editing}
        onClose={onClose}
        title={task?.title ?? 'Task'}
        eyebrow={task ? `${task.createdBy ? `From ${task.createdBy.fullName}` : 'Task'} · ${formatDate(task.createdAt)}` : undefined}
        size="lg"
      >
        {detail.loading && <LoadingState label="Loading task…" />}
        {detail.error && <ErrorState error={detail.error} onRetry={detail.reload} />}
        {task && (
          <div className="request-detail task-detail">
            <div className="task-progress">
              {task.permissions.canProgress && task.status !== 'CANCELLED' ? (
                <div className="segmented-tabs" role="group" aria-label="Task status">
                  {PROGRESS.map((status) => (
                    <button
                      key={status}
                      type="button"
                      className={task.status === status ? 'active' : ''}
                      aria-pressed={task.status === status}
                      disabled={busy}
                      onClick={() => move(status)}
                    >
                      {status === 'DONE' && <Check size={14} aria-hidden="true" />}
                      {TASK_STATUS_LABELS[status]}
                    </button>
                  ))}
                </div>
              ) : (
                <TaskStatus status={task.status} />
              )}
              {busy && <Spinner size={16} />}
              {task.completedAt && task.status === 'DONE' && <small className="muted">Done {relativeTime(task.completedAt).toLowerCase()}</small>}
            </div>

            <div className="request-facts">
              <div className="task-fact-person">
                <span>
                  <UserRound size={16} />
                </span>
                <p>Assigned to</p>
                <strong>
                  <Avatar employee={assignee} size="xs" /> {task.permissions.isAssignee ? 'You' : task.assignee.fullName}
                </strong>
              </div>
              <RequestFact icon={CalendarDays} label="Due" value={task.dueDate ? <DueDate task={task} /> : 'No due date'} />
              <RequestFact icon={Flag} label="Priority" value={<PriorityFlag priority={task.priority} />} />
            </div>

            {task.description && (
              <div className="reason-box task-description">
                <p className="eyebrow">Details</p>
                <p>{task.description}</p>
              </div>
            )}

            <FormError error={error} />

            {task.permissions.canEdit && (
              <div className="request-actions task-actions">
                <button className="button button-ghost" type="button" onClick={() => setConfirm('delete')}>
                  <Trash2 size={16} /> Delete
                </button>
                {task.status === 'CANCELLED' ? (
                  <button className="button button-secondary" type="button" onClick={() => move('TODO')} disabled={busy}>
                    <RotateCcw size={16} /> Restore
                  </button>
                ) : (
                  <button className="button button-secondary" type="button" onClick={() => setConfirm('cancel')} disabled={busy}>
                    <Ban size={16} /> Cancel task
                  </button>
                )}
                <button className="button button-primary" type="button" onClick={() => setEditing(true)}>
                  <Pencil size={16} /> Edit
                </button>
              </div>
            )}

            <section className="task-comments" aria-label="Comments">
              <p className="eyebrow">
                <MessageSquare size={13} aria-hidden="true" /> Comments {task.comments.length ? `· ${task.comments.length}` : ''}
              </p>
              {task.comments.length === 0 && <p className="muted task-comments-empty">No comments yet. Ask a question or post an update.</p>}
              <ol>
                {task.comments.map((entry) => (
                  <li key={entry.id} className={entry.isMine ? 'mine' : ''}>
                    <Avatar employee={chatPerson(entry.author ?? { id: 'gone', fullName: 'Former colleague' })} size="sm" />
                    <div>
                      <p>
                        <strong>{entry.isMine ? 'You' : (entry.author?.fullName ?? 'Former colleague')}</strong>
                        <time dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString()}>
                          {relativeTime(entry.createdAt)}
                        </time>
                      </p>
                      <p className="task-comment-body">{entry.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <form className="task-comment-form" onSubmit={sendComment.submit}>
                <label className="sr-only" htmlFor="task-comment">
                  Add a comment
                </label>
                <textarea
                  id="task-comment"
                  rows="2"
                  value={comment}
                  maxLength={2000}
                  placeholder="Write a comment…"
                  onChange={(event) => setComment(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) sendComment.submit(event)
                  }}
                />
                <button type="submit" className="button button-primary" disabled={sendComment.saving || !comment.trim()} aria-label="Post comment">
                  {sendComment.saving ? <Spinner size={15} /> : <Send size={15} />} Post
                </button>
              </form>
              <FormError error={sendComment.error} />
            </section>
          </div>
        )}
      </Modal>

      <Modal open={editing} onClose={() => setEditing(false)} title="Edit task" eyebrow={task?.title}>
        {editing && task && (
          <TaskForm
            task={task}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false)
              onToast('Task updated.')
              refresh()
            }}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={confirm === 'cancel'}
        title="Cancel this task?"
        message={task ? `"${task.title}" stays on record as cancelled, and ${task.permissions.isAssignee ? 'you' : task.assignee.fullName} no longer has it to do.` : ''}
        confirmLabel="Cancel task"
        tone="danger"
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await updateTask(task.id, { status: 'CANCELLED' })
          onToast('Task cancelled.')
          refresh()
        }}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete this task?"
        message={task ? `"${task.title}" and its comments are removed for everyone. The audit log keeps a note that it existed.` : ''}
        confirmLabel="Delete task"
        tone="danger"
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await deleteTask(task.id)
          onToast('Task deleted.')
          onChanged?.()
          onClose()
        }}
      />
    </>
  )
}
