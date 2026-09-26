import { useEffect, useState } from 'react'
import { ClipboardCheck, Plus } from 'lucide-react'
import { Async, Avatar, DataTable, EmptyState, FilterSelect, PageHeader, Pagination, Panel, SearchInput, SegmentedTabs, StatusPill } from '../components/ui.jsx'
import RequestDetail from '../components/RequestDetail.jsx'
import { RecordLeaveModal } from '../components/RequestFormModal.jsx'
import { useDebouncedValue, useResource } from '../hooks/useResource.js'
import { formatDate, plural, relativeTime } from '../lib/format.js'
import { fetchRequests } from '../api/endpoints.js'

const STATUS_TABS = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: '', label: 'All' },
]

const TYPE_OPTIONS = [
  { value: '', label: 'All request types' },
  { value: 'LEAVE', label: 'Leave' },
  { value: 'DOCUMENT', label: 'Documents' },
  { value: 'PROFILE_CHANGE', label: 'Profile changes' },
]

/**
 * The request inbox. HR sees every request in scope; a manager sees their
 * direct reports' requests and decides them - never their own.
 */
export default function RequestsPage({ session, param, navigate, onToast, onPendingChanged }) {
  const [status, setStatus] = useState('PENDING')
  const [type, setType] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [recording, setRecording] = useState(false)
  const debounced = useDebouncedValue(query, 300)
  useEffect(() => setPage(1), [status, type, debounced])

  const inbox = useResource(
    () => fetchRequests({ status, type, q: debounced, page, pageSize: 25, myTeamOnly: !session.isManagement }),
    [status, type, debounced, page],
  )
  const summary = inbox.data?.summary ?? {}

  return (
    <div className="page">
      <PageHeader
        title={session.isManagement ? 'Requests' : 'Approvals'}
        description={session.isManagement ? 'Leave, document and profile requests from everyone.' : "Your team's leave and other requests."}
        actions={
          session.isManagement && (
            <button className="button button-primary" onClick={() => setRecording(true)}>
              <Plus size={16} /> Record leave
            </button>
          )
        }
      />
      <RecordLeaveModal
        open={recording}
        session={session}
        onClose={() => setRecording(false)}
        onRecorded={() => {
          setRecording(false)
          inbox.reload()
          onPendingChanged?.()
        }}
        onToast={onToast}
      />
      <Panel flush>
        <div className="toolbar">
          <SegmentedTabs label="Status" value={status} onChange={setStatus} options={STATUS_TABS.map((tab) => ({ ...tab, count: tab.value ? summary[tab.value] : undefined }))} />
          <FilterSelect label="Request type" value={type} onChange={setType} options={TYPE_OPTIONS} />
          <SearchInput value={query} onChange={setQuery} placeholder="Reference or name" label="Search requests" />
        </div>
        <Async loading={inbox.loading} error={inbox.error} onRetry={inbox.reload} rows={6}>
          <DataTable
            caption="Requests"
            onRowClick={(row) => navigate('requests', row.id)}
            columns={[
              {
                key: 'employee',
                label: 'Employee',
                primary: true,
                render: (row) => (
                  <div className="person-cell">
                    <Avatar employee={row.employee} size="sm" />
                    <span>
                      <strong>{row.employee?.fullName ?? 'Unknown'}</strong>
                      <small>{row.employee?.department}</small>
                    </span>
                  </div>
                ),
              },
              {
                key: 'request',
                label: 'Request',
                render: (row) => (
                  <div>
                    <strong>{row.subtype}</strong>
                    <small>{row.reference}</small>
                  </div>
                ),
              },
              { key: 'details', label: 'Details', render: (row) => describe(row) },
              { key: 'submitted', label: 'Submitted', render: (row) => relativeTime(row.submittedAt) },
              { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.statusValue} label={row.status} /> },
            ]}
            rows={inbox.data?.items ?? []}
            empty={<EmptyState icon={ClipboardCheck} title={status === 'PENDING' ? 'Nothing waiting' : 'No requests here'} text="Requests matching these filters appear here." />}
          />
          <Pagination meta={inbox.data?.meta} onPage={setPage} />
        </Async>
      </Panel>
      <RequestDetail
        requestId={param}
        onClose={() => navigate('requests')}
        onChanged={() => {
          inbox.reload()
          onPendingChanged?.()
        }}
        onToast={onToast}
      />
    </div>
  )
}

function describe(request) {
  if (request.typeValue === 'LEAVE') {
    return `${formatDate(request.startDate, { year: undefined })} – ${formatDate(request.endDate, { year: undefined })} · ${plural(request.days, 'day')}`
  }
  if (request.typeValue === 'DOCUMENT') return request.purpose ?? 'Document request'
  return request.purpose ?? `${plural(request.changeCount ?? 0, 'field')} proposed`
}
