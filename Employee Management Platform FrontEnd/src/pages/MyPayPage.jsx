import { useState } from 'react'
import { HandCoins, Plus, ReceiptText } from 'lucide-react'
import { Async, DataTable, Detail, EmptyMini, EmptyState, Modal, Money, PageHeader, Panel, StatusPill, Tabs } from '../components/ui.jsx'
import { AdvanceDetail, AdvanceRequestForm } from '../components/advances.jsx'
import { PayslipModal } from './PayslipsPage.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useResource } from '../hooks/useResource.js'
import { openFile } from '../lib/download.js'
import { formatDate, formatMonth } from '../lib/format.js'
import { fetchAdvances, fetchCompensation, fetchPayslips, payslipPdfPath } from '../api/endpoints.js'

/** The employee's own payslips, salary and salary advances. Nobody else's. */
export default function MyPayPage({ session, onToast }) {
  const { currency } = useCompany()
  const [tab, setTab] = useState('payslips')
  const [recordId, setRecordId] = useState(null)
  const [advanceId, setAdvanceId] = useState(null)
  const [requesting, setRequesting] = useState(false)
  const payslips = useResource(() => fetchPayslips(), [])
  const advances = useResource(() => fetchAdvances(), [])
  const salary = useResource(() => (session.employee ? fetchCompensation(session.employee.id) : Promise.resolve(null)), [])
  const current = salary.data?.current

  const open = async (row) => {
    try {
      await openFile(payslipPdfPath(row.id))
    } catch (error) {
      onToast(error.message, 'error')
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="My pay"
        description="Your payslips, salary and advances. Only you and HR can see this."
        actions={
          <button className="button button-primary" onClick={() => setRequesting(true)}>
            <Plus size={16} /> Request a salary advance
          </button>
        }
      />
      {current && (
        <Panel title="My salary" description={`Since ${formatDate(current.effectiveFrom)}`}>
          <dl className="kv-list">
            <Detail label="Basic salary" value={<Money value={current.baseSalary} currency={current.currency} />} />
            <Detail label="Housing" value={<Money value={current.housingAllowance} currency={current.currency} />} />
            <Detail label="Transport" value={<Money value={current.transportAllowance} currency={current.currency} />} />
            <Detail label="Other allowances" value={<Money value={current.otherAllowances} currency={current.currency} />} />
            <Detail label="Total fixed pay" value={<Money value={current.totalFixed} currency={current.currency} />} />
          </dl>
        </Panel>
      )}
      <Panel flush>
        <Tabs
          tabs={[
            { id: 'payslips', label: 'Payslips', count: payslips.data?.length },
            { id: 'advances', label: 'Salary advances', count: advances.data?.items?.length },
          ]}
          active={tab}
          onChange={setTab}
        />
        {tab === 'payslips' ? (
          <Async loading={payslips.loading} error={payslips.error} onRetry={payslips.reload} rows={4}>
            <DataTable
              caption="My payslips"
              onRowClick={(row) => setRecordId(row.id)}
              columns={[
                { key: 'period', label: 'Month', primary: true, render: (row) => <strong>{row.period.name}</strong> },
                { key: 'gross', label: 'Gross', className: 'num', render: (row) => <Money value={row.grossEarnings} currency={row.currency} /> },
                { key: 'deductions', label: 'Deductions', className: 'num', render: (row) => <Money value={row.totalDeductions} currency={row.currency} /> },
                { key: 'net', label: 'Net pay', className: 'num', render: (row) => <strong><Money value={row.netSalary} currency={row.currency} /></strong> },
                { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.period.status} /> },
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
              rows={payslips.data ?? []}
              empty={<EmptyState icon={ReceiptText} title="No payslips yet" text="Your payslip appears here once the month's payroll is approved." />}
            />
          </Async>
        ) : (
          <Async loading={advances.loading} error={advances.error} onRetry={advances.reload} rows={4}>
            {advances.data?.items?.length ? (
              <DataTable
                caption="My salary advances"
                onRowClick={(row) => setAdvanceId(row.id)}
                columns={[
                  {
                    key: 'reference',
                    label: 'Advance',
                    primary: true,
                    render: (row) => (
                      <div>
                        <strong>{row.reference}</strong>
                        <small>Requested {formatDate(row.requestDate)}</small>
                      </div>
                    ),
                  },
                  { key: 'amount', label: 'Original', className: 'num', render: (row) => <Money value={row.originalAmount} currency={row.currency} /> },
                  { key: 'repaid', label: 'Paid back', className: 'num', render: (row) => <Money value={row.repaidAmount} currency={row.currency} /> },
                  { key: 'remaining', label: 'Remaining', className: 'num', render: (row) => <strong><Money value={row.remainingAmount} currency={row.currency} /></strong> },
                  { key: 'next', label: 'Next instalment', render: (row) => (row.nextInstallment ? `${formatMonth(row.nextInstallment.dueMonth)} · ${row.nextInstallment.amount.toFixed(2)}` : '—') },
                  { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
                ]}
                rows={advances.data.items}
              />
            ) : (
              <div className="panel-body">
                <EmptyMini icon={HandCoins} title="No salary advances" text="Request one when you need it; HR sets the repayment plan." />
              </div>
            )}
          </Async>
        )}
      </Panel>
      <PayslipModal recordId={recordId} onClose={() => setRecordId(null)} />
      {advanceId && <AdvanceDetail advanceId={advanceId} mode="own" onClose={() => setAdvanceId(null)} onChanged={advances.reload} onToast={onToast} />}
      <Modal open={requesting} onClose={() => setRequesting(false)} title="Request a salary advance">
        {requesting && (
          <AdvanceRequestForm
            currency={currency}
            onCancel={() => setRequesting(false)}
            onSaved={(advance) => {
              setRequesting(false)
              setTab('advances')
              advances.reload()
              onToast(`${advance.reference} submitted. HR will review it.`)
            }}
          />
        )}
      </Modal>
    </div>
  )
}
