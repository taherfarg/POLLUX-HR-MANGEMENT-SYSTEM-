import { useEffect, useState } from 'react'
import { AlarmClock, CheckCircle2, CircleDot, ListTodo, MessageSquare, Plus, Timer } from 'lucide-react'
import { Async, Avatar, DataTable, EmptyState, FilterSelect, Modal, PageHeader, Pagination, Panel, SearchInput, SegmentedTabs, StatCard } from '../components/ui.jsx'
import { DueDate, PriorityFlag, TaskCheck, TaskDetail, TaskForm, TaskStatus } from '../components/tasks.jsx'
import { useDebouncedValue, useResource } from '../hooks/useResource.js'
import { chatPerson } from '../lib/chat.js'
import { emitChange } from '../lib/events.js'
import { TASK_STATUS_FILTERS, taskViewsFor } from '../lib/tasks.js'
import { fetchTasks, updateTask } from '../api/endpoints.js'

const EMPTY_TEXT = {
  mine: 'Nothing on your list. Tasks your manager or HR give you appear here - and you can add your own.',
  created: 'Tasks you give to yourself or your team appear here.',
  team: 'Nobody in your team has open tasks.',
  all: 'No tasks match.',
}

/** Tasks: given to me, given by me, my team's, and for HR everyone's. */
export default function TasksPage({ session, param, navigate, onToast }) {
  const views = taskViewsFor(session)
  const [view, setView] = useState(views[0].value)
  const [status, setStatus] = useState('open')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)
  const [toggling, setToggling] = useState(null)
  const debounced = useDebouncedValue(query, 300)
  useEffect(() => setPage(1), [view, status, debounced])

  const tasks = useResource(() => fetchTasks({ view, status, q: debounced || undefined, page }), [view, status, debounced, page])
  const summary = tasks.data?.summary ?? {}

  const changed = () => {
    tasks.reload()
    emitChange('tasks')
  }

  const toggle = async (task) => {
    setToggling(task.id)
    try {
      const next = task.status === 'DONE' ? 'TODO' : 'DONE'
      await updateTask(task.id, { status: next })
      onToast(next === 'DONE' ? `Done: ${task.title}` : `Reopened: ${task.title}`)
      changed()
    } catch (error) {
      onToast(error.message || 'Could not update the task.', 'error')
    } finally {
      setToggling(null)
    }
  }

  const showFrom = view === 'mine'
  const columns = [
    { key: 'check', label: 'Done', className: 'task-check-cell', render: (row) => <TaskCheck task={row} onToggle={toggle} busy={toggling === row.id} /> },
    {
      key: 'title',
      label: 'Task',
      primary: true,
      render: (row) => (
        <div className={`task-title ${row.status === 'DONE' || row.status === 'CANCELLED' ? 'task-title-closed' : ''}`}>
          <strong>{row.title}</strong>
          <small>
            <PriorityFlag priority={row.priority} quiet />
            {row.commentCount > 0 && (
              <span className="task-meta">
                <MessageSquare size={12} aria-hidden="true" /> {row.commentCount}
              </span>
            )}
            {row.description && <span className="task-snippet">{row.description}</span>}
          </small>
        </div>
      ),
    },
    showFrom
      ? { key: 'from', label: 'From', render: (row) => (!row.createdBy ? '—' : row.createdBy.id === session.userId ? 'You' : row.createdBy.fullName) }
      : {
          key: 'assignee',
          label: 'Assignee',
          render: (row) => (
            <span className="person-cell">
              <Avatar employee={chatPerson({ id: row.assignee.id, fullName: row.assignee.fullName })} size="xs" />
              <span>{row.permissions.isAssignee ? 'You' : row.assignee.fullName}</span>
            </span>
          ),
        },
    { key: 'due', label: 'Due', className: 'nowrap', render: (row) => <DueDate task={row} /> },
    { key: 'status', label: 'Status', render: (row) => <TaskStatus status={row.status} /> },
  ]

  return (
    <div className="page">
      <PageHeader
        title="Tasks"
        description="Work given to you, by you and to your team - with a comment thread on each task."
        actions={
          <button className="button button-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New task
          </button>
        }
      />

      <div className="stat-grid">
        <StatCard icon={CircleDot} label="To do" value={summary.todo} tone="info" onClick={() => setStatus('TODO')} />
        <StatCard icon={Timer} label="In progress" value={summary.inProgress} tone="violet" onClick={() => setStatus('IN_PROGRESS')} />
        <StatCard icon={AlarmClock} label="Overdue" value={summary.overdue} tone={summary.overdue ? 'danger' : 'neutral'} onClick={() => setStatus('open')} />
        <StatCard icon={CheckCircle2} label="Done this week" value={summary.doneThisWeek} tone="success" onClick={() => setStatus('DONE')} />
      </div>

      <Panel flush>
        <div className="toolbar">
          {views.length > 1 && <SegmentedTabs label="Whose tasks" value={view} onChange={setView} options={views} />}
          <div className="spacer" />
          <FilterSelect label="Status" value={status} onChange={setStatus} options={TASK_STATUS_FILTERS} />
          <SearchInput value={query} onChange={setQuery} placeholder="Task or person" label="Search tasks" />
        </div>
        <Async loading={tasks.loading} error={tasks.error} onRetry={tasks.reload} rows={6}>
          <div className="task-table">
            <DataTable
              caption="Tasks"
              onRowClick={(row) => navigate('tasks', row.id)}
              columns={columns}
              rows={tasks.data?.items ?? []}
              empty={
                <EmptyState
                  icon={ListTodo}
                  title={status === 'open' ? 'All clear' : 'No tasks here'}
                  text={EMPTY_TEXT[view]}
                  action={
                    view === 'mine' || view === 'created' ? (
                      <button className="button button-secondary" onClick={() => setCreating(true)}>
                        <Plus size={16} /> New task
                      </button>
                    ) : undefined
                  }
                />
              }
            />
          </div>
          <Pagination meta={tasks.data?.meta} onPage={setPage} />
        </Async>
      </Panel>

      <Modal open={creating} onClose={() => setCreating(false)} title="New task">
        {creating && (
          <TaskForm
            onCancel={() => setCreating(false)}
            onSaved={(task) => {
              setCreating(false)
              changed()
              onToast(task.permissions.isAssignee ? 'Added to your tasks.' : `Task given to ${task.assignee.fullName}. They have been notified.`)
            }}
          />
        )}
      </Modal>

      {param && <TaskDetail taskId={param} onClose={() => navigate('tasks')} onChanged={changed} onToast={onToast} />}
    </div>
  )
}
