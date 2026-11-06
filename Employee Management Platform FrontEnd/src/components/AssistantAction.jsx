import { useState } from 'react'
import { CheckCircle2, ClipboardCheck, ListTodo, X } from 'lucide-react'
import { FormError, Spinner } from './ui.jsx'
import { emitChange } from '../lib/events.js'
import { approveRequest, createTask, rejectRequest } from '../api/endpoints.js'

const CONFIRM = {
  create_task: () => 'Create task',
  decide_request: (action) => (action.payload.decision === 'REJECT' ? 'Reject' : 'Approve'),
}

/**
 * Something the assistant prepared, waiting for the person to confirm. The
 * assistant never acts itself: confirming here calls the ordinary endpoint as
 * the person, with every check and audit entry the page would have.
 */
export default function AssistantAction({ action, onChange, navigate, onToast, onPendingChanged }) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState(null)
  const Icon = action.type === 'create_task' ? ListTodo : ClipboardCheck
  const label = (CONFIRM[action.type] ?? (() => 'Confirm'))(action)

  const confirm = async () => {
    setWorking(true)
    setError(null)
    try {
      if (action.type === 'create_task') {
        const { assigneeId, title, description, priority, dueDate } = action.payload
        const task = await createTask({ assigneeId, title, description: description || undefined, priority, dueDate: dueDate || undefined })
        onChange({ ...action, status: 'done', result: { taskId: task.id } })
        emitChange('tasks')
        onToast(task.permissions?.isAssignee ? 'Added to your tasks.' : `Task given to ${task.assignee.fullName}. They have been notified.`)
      } else if (action.type === 'decide_request') {
        const { requestId, reference, decision, note } = action.payload
        if (decision === 'REJECT') await rejectRequest(requestId, note)
        else await approveRequest(requestId, note)
        onChange({ ...action, status: 'done' })
        onPendingChanged?.()
        onToast(`${reference} ${decision === 'REJECT' ? 'rejected' : 'approved'}.`)
      }
    } catch (caught) {
      setError(caught)
    } finally {
      setWorking(false)
    }
  }

  const done = action.status === 'done'
  const dismissed = action.status === 'dismissed'

  return (
    <section className={`assistant-action ${done ? 'is-done' : ''} ${dismissed ? 'is-dismissed' : ''}`} aria-label={action.title}>
      <header>
        <span className="assistant-action-icon" aria-hidden="true">
          <Icon size={16} />
        </span>
        <strong>{action.title}</strong>
        {!done && !dismissed && <small>Waiting for you to confirm</small>}
      </header>
      <dl>
        {action.details.map((detail) => (
          <div key={detail.label}>
            <dt>{detail.label}</dt>
            <dd dir="auto">{detail.value}</dd>
          </div>
        ))}
      </dl>
      <FormError error={error} />
      <footer>
        {done ? (
          <>
            <span className="assistant-action-done">
              <CheckCircle2 size={16} aria-hidden="true" />
              {action.type === 'create_task' ? 'Task created' : action.payload.decision === 'REJECT' ? 'Rejected' : 'Approved'}
            </span>
            {action.type === 'create_task' && action.result?.taskId && (
              <button type="button" className="button button-ghost button-sm" onClick={() => navigate('tasks', action.result.taskId)}>
                Open task
              </button>
            )}
            {action.type === 'decide_request' && (
              <button type="button" className="button button-ghost button-sm" onClick={() => navigate('requests')}>
                Open requests
              </button>
            )}
          </>
        ) : dismissed ? (
          <span className="muted">Dismissed - nothing was changed.</span>
        ) : (
          <>
            <button type="button" className="button button-ghost button-sm" onClick={() => onChange({ ...action, status: 'dismissed' })} disabled={working}>
              <X size={15} /> Dismiss
            </button>
            <button
              type="button"
              className={`button button-sm ${action.payload?.decision === 'REJECT' ? 'button-danger' : 'button-primary'}`}
              onClick={confirm}
              disabled={working}
            >
              {working && <Spinner size={14} />} {label}
            </button>
          </>
        )}
      </footer>
    </section>
  )
}
