import { useState } from 'react'
import { ReceiptText } from 'lucide-react'
import { Async, DataTable, EmptyState, FilterSelect, Modal, Money, PageHeader, Panel, SearchInput, StatusPill } from '../components/ui.jsx'
import { PayslipView } from '../components/payroll.jsx'
import { useResource } from '../hooks/useResource.js'
import { openFile } from '../lib/download.js'
import { fetchPayrollRecord, fetchPayslips, payslipPdfPath } from '../api/endpoints.js'

const thisYear = new Date().getFullYear()

/** Payslips from approved and paid payrolls. Opening someone's payslip is audited. */
export default function PayslipsPage({ onToast }) {
  const [year, setYear] = useState(thisYear)
  const [query, setQuery] = useState('')
  const [recordId, setRecordId] = useState(null)
  const payslips = useResource(() => fetchPayslips({ year }), [year])
  const rows = (payslips.data ?? []).filter((row) =>
    `${row.employee.fullName} ${row.employee.employeeNumber} ${row.period.name}`.toLowerCase().includes(query.toLowerCase()),
  )

  const open = async (row) => {
    try {
      await openFile(payslipPdfPath(row.id))
    } catch (error) {
      onToast(error.message, 'error')
    }
  }

  return (
    <div className="page">
      <PageHeader title="Payslips" description="Generated when a payroll is approved and stored as each employee's document." />
      <Panel flush>
        <div className="toolbar">
          <SearchInput value={query} onChange={setQuery} placeholder="Employee or month" label="Search payslips" />
          <FilterSelect
            label="Year"
            value={String(year)}
            onChange={(value) => setYear(Number(value))}
            options={[thisYear - 1, thisYear].map((value) => ({ value: String(value), label: String(value) }))}
          />
        </div>
        <Async loading={payslips.loading} error={payslips.error} onRetry={payslips.reload} rows={6}>
          <DataTable
            caption="Payslips"
            onRowClick={(row) => setRecordId(row.id)}
            columns={[
              {
                key: 'employee',
                label: 'Employee',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>{row.employee.fullName}</strong>
                    <small>{row.employee.employeeNumber}</small>
                  </div>
                ),
              },
              { key: 'period', label: 'Month', render: (row) => row.period.name },
              { key: 'net', label: 'Net', className: 'num', render: (row) => <Money value={row.netSalary} currency={row.currency} /> },
              { key: 'status', label: 'Payroll', render: (row) => <StatusPill status={row.period.status} /> },
              {
                key: 'actions',
                label: '',
                className: 'actions',
                render: (row) =>
                  row.hasPayslip && (
                    <button
                      className="button button-secondary button-sm"
                      onClick={(event) => {
                        event.stopPropagation()
                        open(row)
                      }}
                    >
                      <ReceiptText size={14} /> PDF
                    </button>
                  ),
              },
            ]}
            rows={rows}
            empty={<EmptyState icon={ReceiptText} title="No payslips" text="Payslips appear after a payroll is approved." />}
          />
        </Async>
      </Panel>
      <PayslipModal recordId={recordId} onClose={() => setRecordId(null)} />
    </div>
  )
}

export function PayslipModal({ recordId, onClose }) {
  const record = useResource(() => fetchPayrollRecord(recordId), [recordId], { enabled: Boolean(recordId) })
  if (!recordId) return null
  return (
    <Modal open onClose={onClose} title={record.data ? `${record.data.period.name} payslip` : 'Payslip'} eyebrow={record.data?.employee.fullName} size="lg">
      <Async loading={record.loading} error={record.error} rows={6}>
        {record.data && <PayslipView record={record.data} />}
      </Async>
    </Modal>
  )
}
