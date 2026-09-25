import { useEffect, useState } from 'react'
import { ArrowRight, CalendarDays, Check, CheckCircle2, Clock3, FileText, Globe2, Plane, UserRound, X } from 'lucide-react'
import { Avatar, ErrorState, FormError, LoadingState, Modal, RequestFact, Spinner, StatusPill } from './ui.jsx'
import LetterModal from './LetterModal.jsx'
import { useResource } from '../hooks/useResource.js'
import { formatDate, plural } from '../lib/format.js'
import { approveRequest, cancelRequest, fetchRequest, rejectRequest } from '../api/endpoints.js'

/**
 * One request, with the decision controls the caller is entitled to. Whether
 * the caller may decide is still checked by the API - a manager deciding
 * their own request, or someone else's team, is refused there.
 */
export default function RequestDetail({ requestId, onClose, onChanged, onToast, mode = 'decide' }) {
  const [letterId, setLetterId] = useState(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const detail = useResource(() => fetchRequest(requestId), [requestId], { enabled: Boolean(requestId) })
  const request = detail.data

  useEffect(() => {
    setNote('')
    setError(null)
  }, [request?.id])

  if (!requestId) return null

  const isPending = request?.statusValue === 'PENDING'

  const act = async (action) => {
    setBusy(true)
    setError(null)
    try {
      if (action === 'approve') {
        await approveRequest(request.id, note)
        onToast(`${request.reference} approved.`)
      } else if (action === 'reject') {
        if (note.trim().length < 3) {
          setError('Add a short reason - the employee sees it.')
          setBusy(false)
          return
        }
        await rejectRequest(request.id, note.trim())
        onToast(`${request.reference} rejected.`)
      } else {
        await cancelRequest(request.id, note)
        onToast(`${request.reference} withdrawn.`)
      }
      detail.reload()
      onChanged?.()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={Boolean(requestId)} onClose={onClose} title={request?.subtype ?? 'Request'} eyebrow={request ? `${request.reference} · submitted ${formatDate(request.submittedAt)}` : undefined} size="lg">
      {detail.loading && <LoadingState label="Loading request…" />}
      {detail.error && <ErrorState error={detail.error} onRetry={detail.reload} />}

      {request && (
        <div className="request-detail">
          <div className="request-person">
            <Avatar employee={request.employee} />
            <div>
              <strong>{request.employee?.fullName}</strong>
              <span>
                {request.employee?.role} · {request.employee?.department}
              </span>
            </div>
            <StatusPill status={request.statusValue} label={request.status} />
          </div>

          <div className="request-facts">
            {request.typeValue === 'LEAVE' && (
              <>
                <RequestFact icon={CalendarDays} label="Dates" value={`${formatDate(request.startDate)} – ${formatDate(request.endDate)}`} />
                <RequestFact icon={Clock3} label="Working days" value={plural(request.days, 'day')} />
                <RequestFact icon={Plane} label="Leave type" value={request.subtype} />
              </>
            )}
            {request.typeValue === 'DOCUMENT' && (
              <>
                <RequestFact icon={FileText} label="Document" value={request.subtype} />
                <RequestFact icon={Globe2} label="Language" value={request.language} />
                <RequestFact icon={UserRound} label="Addressed to" value={request.addressedTo ?? 'Not specified'} />
              </>
            )}
            {request.typeValue === 'PROFILE_CHANGE' && (
              <>
                <RequestFact icon={UserRound} label="Fields" value={`${request.changeCount} proposed`} />
                <RequestFact icon={CheckCircle2} label="Applied" value={request.appliedAt ? formatDate(request.appliedAt) : 'Not yet'} />
              </>
            )}
          </div>

          {request.typeValue === 'PROFILE_CHANGE' && Array.isArray(request.changes) && (
            <div className="change-list">
              <p className="eyebrow">Proposed changes</p>
              {request.changes.map((change) => (
                <div className="change-row" key={change.field}>
                  <span>{change.label}</span>
                  <del>{change.currentValue || 'Not set'}</del>
                  <ArrowRight size={14} />
                  <ins>{change.proposedValue}</ins>
                </div>
              ))}
            </div>
          )}

          {request.reason && (
            <div className="reason-box">
              <p className="eyebrow">Employee note</p>
              <blockquote>“{request.reason}”</blockquote>
              {request.handoverNotes && (
                <p className="handover">
                  <strong>Handover:</strong> {request.handoverNotes}
                </p>
              )}
            </div>
          )}
          {request.purpose && request.typeValue === 'DOCUMENT' && (
            <div className="reason-box">
              <p className="eyebrow">Purpose</p>
              <blockquote>“{request.purpose}”</blockquote>
            </div>
          )}

          {request.issuedDocument && (
            <div className="issued-document">
              <FileText size={18} />
              <div>
                <strong>{request.issuedDocument.title}</strong>
                <small>{request.issuedDocument.fileName}</small>
              </div>
              <button className="button button-secondary" onClick={() => setLetterId(request.issuedDocument.id)}>
                Read letter
              </button>
            </div>
          )}

          {request.adminNote && !isPending && (
            <div className="reason-box">
              <p className="eyebrow">Decision note</p>
              <blockquote>{request.adminNote}</blockquote>
            </div>
          )}
          {request.decidedAt && (
            <p className="decision-meta">
              <CheckCircle2 size={15} /> Decided {formatDate(request.decidedAt)}
              {request.decidedBy ? ` by ${request.decidedBy}` : ''}
            </p>
          )}

          {isPending && (
            <div className="decision-box">
              <label className="field">
                <span>{mode === 'decide' ? 'Decision note' : 'Note'} <small>{mode === 'decide' ? 'Shared with the employee; required to reject' : 'Optional'}</small></span>
                <textarea rows="3" value={note} onChange={(event) => setNote(event.target.value)} disabled={busy} />
              </label>
            </div>
          )}

          <FormError error={error} />

          {isPending && mode === 'decide' && (
            <div className="request-actions">
              <button className="button button-danger" onClick={() => act('reject')} disabled={busy}>
                <X size={16} /> Reject
              </button>
              <button className="button button-primary" onClick={() => act('approve')} disabled={busy}>
                {busy ? <Spinner size={15} /> : <Check size={16} />} Approve
              </button>
            </div>
          )}
          {isPending && mode === 'own' && (
            <div className="request-actions">
              <button className="button button-danger" onClick={() => act('cancel')} disabled={busy}>
                {busy ? <Spinner size={15} /> : <X size={16} />} Withdraw request
              </button>
            </div>
          )}
        </div>
      )}
      <LetterModal documentId={letterId} onClose={() => setLetterId(null)} />
    </Modal>
  )
}
