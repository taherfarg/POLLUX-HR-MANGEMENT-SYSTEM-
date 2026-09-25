import { useState } from 'react'
import { CalendarPlus, ClipboardCheck, FileText, UserRoundPen } from 'lucide-react'
import { Async, DataTable, EmptyState, PageHeader, Panel, SegmentedTabs, StatusPill } from '../components/ui.jsx'
import { BalanceCards } from '../components/leave.jsx'
import RequestDetail from '../components/RequestDetail.jsx'
import RequestFormModal from '../components/RequestFormModal.jsx'
import { useResource } from '../hooks/useResource.js'
import { formatDate, plural, relativeTime } from '../lib/format.js'
import { fetchMyBalances, fetchMyProfile, fetchMyRequests } from '../api/endpoints.js'

/** Leave, HR documents and profile updates - submitted, followed and withdrawn here. */
export default function MyRequestsPage({ onToast }) {
  const [status, setStatus] = useState('')
  const [formType, setFormType] = useState(null)
  const [openId, setOpenId] = useState(null)
  const requests = useResource(() => fetchMyRequests({ status: status || undefined }), [status])
  const balances = useResource(() => fetchMyBalances(), [])
  const profile = useResource(() => fetchMyProfile(), [])
  const summary = requests.data?.summary ?? {}

  const refresh = () => {
    requests.reload()
    balances.reload()
  }

  return (
    <div className="page">
      <PageHeader
        title="My requests"
        description="Time off, HR letters and changes to your details."
        actions={
          <>
            <button className="button button-primary" onClick={() => setFormType('Leave')}>
              <CalendarPlus size={16} /> Request leave
            </button>
            <button className="button button-secondary" onClick={() => setFormType('Document')}>
              <FileText size={16} /> Request a document
            </button>
            <button className="button button-secondary" onClick={() => setFormType('Profile')}>
              <UserRoundPen size={16} /> Update my details
            </button>
          </>
        }
      />
      <Panel title="Leave balances" description={`${new Date().getFullYear()}: entitlement plus carried over, minus used and pending.`}>
        <Async loading={balances.loading} error={balances.error} onRetry={balances.reload} rows={2}>
          <BalanceCards balances={balances.data} />
        </Async>
      </Panel>
      <Panel flush>
        <div className="toolbar">
          <SegmentedTabs
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: 'All' },
              { value: 'PENDING', label: 'Pending', count: summary.PENDING },
              { value: 'APPROVED', label: 'Approved' },
              { value: 'REJECTED', label: 'Rejected' },
              { value: 'CANCELLED', label: 'Withdrawn' },
            ]}
          />
        </div>
        <Async loading={requests.loading} error={requests.error} onRetry={requests.reload} rows={5}>
          <DataTable
            caption="My requests"
            onRowClick={(row) => setOpenId(row.id)}
            columns={[
              {
                key: 'request',
                label: 'Request',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>{row.subtype}</strong>
                    <small>{row.reference}</small>
                  </div>
                ),
              },
              {
                key: 'details',
                label: 'Details',
                render: (row) =>
                  row.typeValue === 'LEAVE'
                    ? `${formatDate(row.startDate, { year: undefined })} – ${formatDate(row.endDate, { year: undefined })} · ${plural(row.days, 'day')}`
                    : row.purpose ?? '—',
              },
              { key: 'submitted', label: 'Submitted', render: (row) => relativeTime(row.submittedAt) },
              { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.statusValue} label={row.status} /> },
            ]}
            rows={requests.data?.items ?? []}
            empty={<EmptyState icon={ClipboardCheck} title="No requests yet" text="Your leave and document requests appear here." />}
          />
        </Async>
      </Panel>
      <RequestFormModal
        type={formType}
        profile={profile.data}
        balances={balances.data ?? []}
        onClose={() => setFormType(null)}
        onSubmitted={() => {
          setFormType(null)
          refresh()
        }}
        onToast={onToast}
      />
      <RequestDetail requestId={openId} mode="own" onClose={() => setOpenId(null)} onChanged={refresh} onToast={onToast} />
    </div>
  )
}
