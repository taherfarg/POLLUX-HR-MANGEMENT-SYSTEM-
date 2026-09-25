import { useEffect, useState } from 'react'
import { HandCoins, Plus } from 'lucide-react'
import { Async, DataTable, EmptyState, Modal, Money, PageHeader, Pagination, Panel, SearchInput, SegmentedTabs, StatusPill, humanize } from '../components/ui.jsx'
import { AdvanceDetail, AdvanceRequestForm } from '../components/advances.jsx'
import { EmployeePicker } from './AttendancePage.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useDebouncedValue, useResource } from '../hooks/useResource.js'
import { formatDate, formatMonth } from '../lib/format.js'
import { fetchAdvances } from '../api/endpoints.js'

const STATUSES = ['PENDING', 'APPROVED', 'ACTIVE', 'PAID', 'COMPLETED', 'REJECTED', 'CANCELLED', '']

/** Salary advances for HR: decide, pay out, and follow repayment through payroll. */
export default function AdvancesPage({ onToast }) {
  const { currency } = useCompany()
  const [status, setStatus] = useState('PENDING')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [openId, setOpenId] = useState(null)
  const [creating, setCreating] = useState(false)
  const debounced = useDebouncedValue(query, 300)
  useEffect(() => setPage(1), [status, debounced])

  const advances = useResource(() => fetchAdvances({ status: status || undefined, q: debounced || undefined, page, pageSize: 25 }), [status, debounced, page])
  const summary = advances.data?.summary ?? {}

  return (
    <div className="page">
      <PageHeader
        title="Salary advances"
        description={`Outstanding across everyone: ${currency} ${Number(summary.outstandingAmount ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
        actions={
          <button className="button button-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> Record a request
          </button>
        }
      />
      <Panel flush>
        <div className="toolbar">
          <SegmentedTabs
            label="Status"
            value={status}
            onChange={setStatus}
            options={STATUSES.map((value) => ({ value, label: value ? humanize(value) : 'All', count: value ? summary[value] : undefined }))}
          />
          <SearchInput value={query} onChange={setQuery} placeholder="Reference or name" label="Search advances" />
        </div>
        <Async loading={advances.loading} error={advances.error} onRetry={advances.reload} rows={6}>
          <DataTable
            caption="Salary advances"
            onRowClick={(row) => setOpenId(row.id)}
            columns={[
              {
                key: 'employee',
                label: 'Employee',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>{row.employee.fullName}</strong>
                    <small>
                      {row.reference} · {formatDate(row.requestDate)}
                    </small>
                  </div>
                ),
              },
              { key: 'amount', label: 'Amount', className: 'num', render: (row) => <Money value={row.originalAmount} currency={row.currency} /> },
              { key: 'plan', label: 'Plan', render: (row) => (row.numberOfInstallments ? `${row.installmentsPaid}/${row.numberOfInstallments} paid` : row.requestedInstallments ? `${row.requestedInstallments} months asked` : '—') },
              { key: 'remaining', label: 'Remaining', className: 'num', render: (row) => <Money value={row.remainingAmount} currency={row.currency} /> },
              { key: 'next', label: 'Next instalment', render: (row) => (row.nextInstallment ? formatMonth(row.nextInstallment.dueMonth) : '—') },
              { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
            ]}
            rows={advances.data?.items ?? []}
            empty={<EmptyState icon={HandCoins} title="No advances here" text={status === 'PENDING' ? 'Nothing is waiting for a decision.' : undefined} />}
          />
          <Pagination meta={advances.data?.meta} onPage={setPage} />
        </Async>
      </Panel>
      {openId && <AdvanceDetail advanceId={openId} mode="hr" onClose={() => setOpenId(null)} onChanged={advances.reload} onToast={onToast} />}
      <Modal open={creating} onClose={() => setCreating(false)} title="Record an advance request" eyebrow="On behalf of an employee">
        {creating && (
          <AdvanceRequestForm
            currency={currency}
            employeePicker={(value, onChange, error) => <EmployeePicker value={value} onChange={onChange} error={error} />}
            onCancel={() => setCreating(false)}
            onSaved={(advance) => {
              setCreating(false)
              advances.reload()
              onToast(`${advance.reference} recorded. Another HR user or an administrator can decide it.`)
            }}
          />
        )}
      </Modal>
    </div>
  )
}
