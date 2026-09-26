import { useMemo, useState } from 'react'
import { ArrowLeft, BriefcaseBusiness, Clock, Download, ExternalLink, FileText, Globe2, LockKeyhole, MapPin, Pencil, Plus, ReceiptText, UserRoundPen } from 'lucide-react'
import {
  Async,
  Avatar,
  Chip,
  DataTable,
  Detail,
  EmptyMini,
  EmptyState,
  ErrorState,
  FormError,
  FormField,
  Modal,
  Money,
  Spinner,
  StatusPill,
  Tabs,
  humanize,
  useSubmit,
} from './ui.jsx'
import { MonthCalendar } from './attendance.jsx'
import { BalanceCards } from './leave.jsx'
import EmployeeForm from './EmployeeForm.jsx'
import LetterModal from './LetterModal.jsx'
import RequestFormModal, { RecordLeaveModal } from './RequestFormModal.jsx'
import { useResource } from '../hooks/useResource.js'
import { downloadFile, openFile } from '../lib/download.js'
import { currentMonthKey, formatDate, formatDays, formatMinutes, formatMonth, monthBounds, shiftMonthKey, todayIso } from '../lib/format.js'
import {
  addCompensation,
  changeEmployeeStatus,
  documentDownloadPath,
  fetchAdvances,
  fetchCompensation,
  fetchEmployee,
  fetchEmployeeBalances,
  fetchEmployeeDocuments,
  fetchEmployeeTimeline,
  fetchMyAttendance,
  fetchMyBalances,
  fetchMyDocuments,
  fetchMyProfile,
  fetchMyRequests,
  fetchMyTimeline,
  fetchPayslips,
  fetchRequests,
  fetchTimesheet,
  payslipPdfPath,
} from '../api/endpoints.js'
import { EMPLOYEE_STATUS_OPTIONS } from '../data.js'

/**
 * One profile for three audiences: HR (everything, editable), a line manager
 * (working context, no pay, no personal data) and the employee themselves.
 * Tabs come from the capabilities the API computed for this caller - the API
 * still enforces each rule on its own endpoint.
 */
export default function EmployeeProfile({ employeeId, self = false, session, onBack, onToast, onChanged }) {
  const profile = useResource(() => (self ? fetchMyProfile() : fetchEmployee(employeeId)), [employeeId, self])
  const [tab, setTab] = useState('overview')
  const [editing, setEditing] = useState(false)
  const [changingStatus, setChangingStatus] = useState(false)
  const [requesting, setRequesting] = useState(false)

  const employee = profile.data
  const caps = employee?.capabilities ?? {}

  const tabs = useMemo(() => {
    if (!employee) return []
    return [
      { id: 'overview', label: 'Overview' },
      caps.canViewPersonal && { id: 'personal', label: 'Personal' },
      { id: 'employment', label: 'Employment' },
      caps.canViewAttendance && { id: 'attendance', label: 'Attendance' },
      caps.canViewLeave && { id: 'leave', label: 'Leave' },
      caps.canViewCompensation && { id: 'salary', label: 'Salary' },
      caps.canViewPayData && { id: 'advances', label: 'Advances' },
      caps.canViewPayData && { id: 'payroll', label: 'Payroll' },
      caps.canViewDocuments && { id: 'documents', label: 'Documents' },
      caps.canViewTimeline && { id: 'timeline', label: 'Timeline' },
    ].filter(Boolean)
  }, [employee, caps.canViewPersonal, caps.canViewAttendance, caps.canViewLeave, caps.canViewCompensation, caps.canViewPayData, caps.canViewDocuments, caps.canViewTimeline])

  if (profile.loading) return <Async loading rows={6} />
  if (profile.error) return <ErrorState error={profile.error} onRetry={profile.reload} />
  if (!employee) return null

  const refresh = () => {
    profile.reload()
    onChanged?.()
  }

  return (
    <div className="page">
      {onBack && (
        <div>
          <button className="button button-ghost button-sm" onClick={onBack}>
            <ArrowLeft size={15} /> All employees
          </button>
        </div>
      )}

      <section className="panel">
        <div className="profile-hero">
          <Avatar employee={employee} size="xl" />
          <div>
            <h2>{employee.fullName}</h2>
            <p>
              {employee.role} · {employee.department}
            </p>
            <div className="chips">
              <StatusPill status={employee.statusValue} label={employee.status} />
              <Chip>{employee.employeeNumber}</Chip>
              {employee.workLocationName && <Chip icon={MapPin}>{employee.workLocationName}</Chip>}
              <Chip icon={BriefcaseBusiness}>{employee.workMode}</Chip>
              {employee.effectiveTimezone && <Chip icon={Globe2}>{employee.effectiveTimezone}</Chip>}
            </div>
          </div>
          <div className="button-row">
            {caps.canEdit && (
              <>
                <button className="button button-secondary" onClick={() => setEditing(true)}>
                  <Pencil size={15} /> Edit
                </button>
                <button className="button button-ghost" onClick={() => setChangingStatus(true)}>
                  Change status
                </button>
              </>
            )}
            {self && (
              <button className="button button-secondary" onClick={() => setRequesting(true)}>
                <UserRoundPen size={15} /> Update my details
              </button>
            )}
          </div>
        </div>
        <Tabs tabs={tabs} active={tab} onChange={setTab} label="Profile sections" />
        <div className="panel-body">
          {tab === 'overview' && <OverviewTab employee={employee} caps={caps} self={self} />}
          {tab === 'personal' && <PersonalTab employee={employee} />}
          {tab === 'employment' && <EmploymentTab employee={employee} />}
          {tab === 'attendance' && <AttendanceTab employee={employee} self={self} />}
          {tab === 'leave' && <LeaveTab employee={employee} self={self} canRecord={caps.canEdit && !self} session={session} onToast={onToast} />}
          {tab === 'salary' && <SalaryTab employee={employee} canEdit={caps.canEdit} onToast={onToast} />}
          {tab === 'advances' && <AdvancesTab employee={employee} self={self} />}
          {tab === 'payroll' && <PayrollTab employee={employee} self={self} onToast={onToast} />}
          {tab === 'documents' && <DocumentsTab employee={employee} self={self} onToast={onToast} />}
          {tab === 'timeline' && <TimelineTab employee={employee} self={self} />}
        </div>
      </section>

      <Modal open={editing} onClose={() => setEditing(false)} title={`Edit ${employee.fullName}`} eyebrow={employee.employeeNumber} size="lg">
        <EmployeeForm
          employee={employee}
          session={session}
          onCancel={() => setEditing(false)}
          onSaved={(message) => {
            setEditing(false)
            refresh()
            onToast(message)
          }}
          onToast={onToast}
        />
      </Modal>

      <Modal open={changingStatus} onClose={() => setChangingStatus(false)} title="Change employment status" eyebrow={employee.fullName}>
        <StatusChangeForm
          employee={employee}
          onCancel={() => setChangingStatus(false)}
          onSaved={(message) => {
            setChangingStatus(false)
            refresh()
            onToast(message)
          }}
        />
      </Modal>

      {self && (
        <RequestFormModal
          type={requesting ? 'Profile' : null}
          profile={employee}
          onClose={() => setRequesting(false)}
          onSubmitted={() => setRequesting(false)}
          onToast={onToast}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function OverviewTab({ employee, caps, self }) {
  return (
    <div className="page">
      <dl className="kv-list">
        <Detail label="Job title" value={employee.role} />
        <Detail label="Department" value={employee.department} />
        <Detail label="Manager" value={employee.managerName ?? 'None'} />
        <Detail label="Work location" value={employee.workLocationName} />
        <Detail label="Work mode" value={employee.workMode} />
        <Detail label="Timezone" value={employee.effectiveTimezone} />
        <Detail label="Work schedule" value={employee.workScheduleName ?? (employee.viewLevel === 'DIRECTORY' ? undefined : 'Company default')} />
        <Detail label="Joined" value={formatDate(employee.joinDate)} />
        <Detail label="Work email" value={employee.email} />
        <Detail label="Phone" value={employee.phone} />
        {employee.directReportCount > 0 && <Detail label="Direct reports" value={employee.directReportCount} />}
      </dl>
      {!caps.canViewCompensation && !self && (
        <p className="lock-note">
          <LockKeyhole size={13} /> Salary, payroll and personal details are visible to HR and the employee only.
        </p>
      )}
    </div>
  )
}

function PersonalTab({ employee }) {
  return (
    <dl className="kv-list">
      <Detail label="Personal email" value={employee.personalEmail} />
      <Detail label="Phone" value={employee.phone} />
      <Detail label="Date of birth" value={formatDate(employee.dateOfBirth)} />
      <Detail label="Gender" value={humanize(employee.gender)} />
      <Detail label="Nationality" value={employee.nationality} />
      <Detail label="Home address" value={employee.address} />
      <Detail label="Emergency contact" value={employee.emergencyContact} />
      <Detail label="Emergency phone" value={employee.emergencyContactPhone} />
    </dl>
  )
}

function EmploymentTab({ employee }) {
  return (
    <dl className="kv-list">
      <Detail label="Employee number" value={employee.employeeNumber} />
      <Detail label="Job title" value={employee.role} />
      <Detail label="Department" value={employee.department} />
      <Detail label="Manager" value={employee.managerName ?? 'None'} />
      <Detail label="Employment type" value={employee.employmentType} />
      <Detail label="Contract type" value={employee.contractType} />
      <Detail label="Contract end" value={employee.contractEnd ? formatDate(employee.contractEnd) : undefined} />
      <Detail label="Work mode" value={employee.workMode} />
      <Detail label="Work location" value={employee.workLocationName} />
      <Detail label="Country of work" value={employee.workCountry} />
      <Detail label="City of work" value={employee.workCity} />
      <Detail label="Timezone" value={employee.effectiveTimezone} />
      <Detail label="Joining date" value={formatDate(employee.joinDate)} />
      <Detail label="Probation ends" value={employee.probationEnd ? formatDate(employee.probationEnd) : undefined} />
      <Detail label="Status" value={employee.status} />
      <Detail label="Work schedule" value={employee.workScheduleName ?? 'Company default'} />
      <Detail label="Holiday calendar" value={employee.holidayCalendarName ?? 'Company default'} />
      <Detail label="Notice period" value={employee.noticePeriodDays !== undefined ? `${employee.noticePeriodDays} days` : undefined} />
      {employee.attendanceTracked !== undefined && <Detail label="Attendance" value={employee.attendanceTracked ? 'Checks in and out' : 'Not tracked'} />}
      {employee.overtimeEligible !== undefined && <Detail label="Overtime" value={employee.overtimeEligible ? 'Eligible' : 'Not eligible'} />}
      {employee.account !== undefined && (
        <Detail label="Login" value={employee.account ? `${employee.account.email} (${humanize(employee.account.role)}${employee.account.isActive ? '' : ', inactive'})` : 'No login'} />
      )}
    </dl>
  )
}

function AttendanceTab({ employee, self }) {
  const [month, setMonth] = useState(currentMonthKey())
  const { from, to } = monthBounds(month)
  const timesheet = useResource(
    () => (self ? fetchMyAttendance({ from, to }) : fetchTimesheet({ employeeId: employee.id, from, to })),
    [employee.id, self, month],
  )
  const totals = timesheet.data?.totals

  return (
    <div className="page">
      <div className="section-title">
        <div className="button-row">
          <button className="button button-secondary button-sm" onClick={() => setMonth(shiftMonthKey(month, -1))} aria-label="Previous month">
            ‹
          </button>
          <strong>{formatMonth(month)}</strong>
          <button className="button button-secondary button-sm" onClick={() => setMonth(shiftMonthKey(month, 1))} aria-label="Next month">
            ›
          </button>
        </div>
        {timesheet.data?.timezone && <span className="small muted">Times in {timesheet.data.timezone}</span>}
      </div>
      <Async loading={timesheet.loading} error={timesheet.error} onRetry={timesheet.reload} rows={5}>
        {timesheet.data && (
          <>
            {totals && (
              <div className="stat-grid">
                <MiniStat label="Present" value={totals.presentDays} />
                <MiniStat label="Late" value={`${totals.lateDays} (${formatMinutes(totals.lateMinutes)})`} />
                <MiniStat label="Absent" value={totals.absentDays} />
                <MiniStat label="Leave" value={totals.leaveDays} />
                <MiniStat label="Worked" value={formatMinutes(totals.workedMinutes)} />
                <MiniStat label="Overtime" value={formatMinutes(totals.overtimeMinutes)} />
              </div>
            )}
            <MonthCalendar days={timesheet.data.days} todayKey={todayIso()} />
          </>
        )}
      </Async>
    </div>
  )
}

function MiniStat({ label, value }) {
  return (
    <div className="stat-card">
      <span>
        <strong style={{ fontSize: 18 }}>{value}</strong>
        <span className="stat-label">{label}</span>
      </span>
    </div>
  )
}

function LeaveTab({ employee, self, canRecord, session, onToast }) {
  const balances = useResource(() => (self ? fetchMyBalances() : fetchEmployeeBalances(employee.id)), [employee.id, self])
  const requests = useResource(
    () => (self ? fetchMyRequests({ type: 'LEAVE' }) : fetchRequests({ employeeId: employee.id, type: 'LEAVE', pageSize: 20 })),
    [employee.id, self],
  )
  const [recording, setRecording] = useState(false)
  return (
    <div className="page">
      <Async loading={balances.loading} error={balances.error} onRetry={balances.reload} rows={2}>
        <BalanceCards balances={balances.data} />
      </Async>
      <div>
        <div className="section-title">
          <h4>Leave requests</h4>
          {canRecord && (
            <button className="button button-secondary button-sm" onClick={() => setRecording(true)}>
              <Plus size={14} /> Record leave
            </button>
          )}
        </div>
        {canRecord && (
          <RecordLeaveModal
            open={recording}
            employee={employee}
            session={session}
            onClose={() => setRecording(false)}
            onRecorded={() => {
              setRecording(false)
              balances.reload()
              requests.reload()
            }}
            onToast={onToast}
          />
        )}
        <Async loading={requests.loading} error={requests.error} onRetry={requests.reload} rows={3}>
          <DataTable
            columns={[
              { key: 'subtype', label: 'Type', primary: true, render: (row) => <strong>{row.subtype}</strong> },
              { key: 'dates', label: 'Dates', render: (row) => `${formatDate(row.startDate, { year: undefined })} – ${formatDate(row.endDate)}` },
              { key: 'days', label: 'Days', className: 'num', render: (row) => formatDays(row.days) },
              { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.statusValue} label={row.status} /> },
            ]}
            rows={requests.data?.items ?? []}
            empty={<EmptyMini icon={FileText} title="No leave requests" text="Requests appear here once submitted." />}
          />
        </Async>
      </div>
    </div>
  )
}

function SalaryTab({ employee, canEdit, onToast }) {
  const compensation = useResource(() => fetchCompensation(employee.id), [employee.id])
  const [adding, setAdding] = useState(false)
  const current = compensation.data?.current
  const history = compensation.data?.history ?? []

  if (compensation.error) return <ErrorState error={compensation.error} compact />

  return (
    <Async loading={compensation.loading} rows={3}>
      <div className="page">
        <p className="lock-note">
          <LockKeyhole size={13} /> Visible to HR and the employee only. Opening another person&apos;s salary is recorded in the audit trail.
        </p>
        {current ? (
          <dl className="kv-list">
            <Detail label="Basic salary" value={<Money value={current.baseSalary} currency={current.currency} />} />
            <Detail label="Housing allowance" value={<Money value={current.housingAllowance} currency={current.currency} />} />
            <Detail label="Transport allowance" value={<Money value={current.transportAllowance} currency={current.currency} />} />
            <Detail label="Other allowances" value={<Money value={current.otherAllowances} currency={current.currency} />} />
            <Detail label="Total fixed pay" value={<Money value={current.totalFixed} currency={current.currency} />} />
            <Detail label="Pay frequency" value={humanize(current.payFrequency)} />
            <Detail label="Effective from" value={formatDate(current.effectiveFrom)} />
            <Detail label="Reason" value={current.changeReason} />
          </dl>
        ) : (
          <EmptyMini icon={FileText} title="No salary recorded" text="Payroll skips an employee until a salary is recorded." />
        )}
        {history.length > 0 && (
          <div>
            <div className="section-title">
              <h4>Salary history</h4>
              {canEdit && (
                <button className="button button-secondary button-sm" onClick={() => setAdding(true)}>
                  <Plus size={14} /> Record a change
                </button>
              )}
            </div>
            <DataTable
              columns={[
                { key: 'effectiveFrom', label: 'From', primary: true, render: (row) => <strong>{formatDate(row.effectiveFrom)}</strong> },
                { key: 'effectiveTo', label: 'To', render: (row) => (row.effectiveTo ? formatDate(row.effectiveTo) : 'Current') },
                { key: 'baseSalary', label: 'Basic', className: 'num', render: (row) => <Money value={row.baseSalary} currency={row.currency} /> },
                { key: 'totalFixed', label: 'Total fixed', className: 'num', render: (row) => <Money value={row.totalFixed} currency={row.currency} /> },
                { key: 'changeReason', label: 'Reason' },
              ]}
              rows={history}
            />
          </div>
        )}
        {!history.length && canEdit && (
          <div>
            <button className="button button-primary" onClick={() => setAdding(true)}>
              <Plus size={15} /> Record salary
            </button>
          </div>
        )}
        <Modal open={adding} onClose={() => setAdding(false)} title="Record a salary change" eyebrow={employee.fullName}>
          <CompensationForm
            employeeId={employee.id}
            current={current}
            currency={current?.currency ?? employee.currency ?? 'AED'}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false)
              compensation.reload()
              onToast('Salary change recorded.')
            }}
          />
        </Modal>
      </div>
    </Async>
  )
}

function CompensationForm({ employeeId, current, currency, onCancel, onSaved }) {
  const [form, setForm] = useState({
    baseSalary: current?.baseSalary ?? '',
    housingAllowance: current?.housingAllowance ?? 0,
    transportAllowance: current?.transportAllowance ?? 0,
    otherAllowances: current?.otherAllowances ?? 0,
    effectiveFrom: todayIso(),
    changeReason: '',
  })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    await addCompensation(employeeId, {
      baseSalary: Number(form.baseSalary),
      housingAllowance: Number(form.housingAllowance || 0),
      transportAllowance: Number(form.transportAllowance || 0),
      otherAllowances: Number(form.otherAllowances || 0),
      currency,
      effectiveFrom: form.effectiveFrom,
      changeReason: form.changeReason,
    })
    onSaved()
  })

  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <div className="two-col">
        <FormField label={`Basic salary (${currency}/month)`} error={error?.fieldError?.('baseSalary')}>
          <input type="number" min="0" step="0.01" value={form.baseSalary} onChange={(e) => set('baseSalary', e.target.value)} required />
        </FormField>
        <FormField label="Effective from" error={error?.fieldError?.('effectiveFrom')}>
          <input type="date" value={form.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} required />
        </FormField>
        <FormField label="Housing allowance">
          <input type="number" min="0" step="0.01" value={form.housingAllowance} onChange={(e) => set('housingAllowance', e.target.value)} />
        </FormField>
        <FormField label="Transport allowance">
          <input type="number" min="0" step="0.01" value={form.transportAllowance} onChange={(e) => set('transportAllowance', e.target.value)} />
        </FormField>
        <FormField label="Other allowances">
          <input type="number" min="0" step="0.01" value={form.otherAllowances} onChange={(e) => set('otherAllowances', e.target.value)} />
        </FormField>
      </div>
      <FormField label="Reason" error={error?.fieldError?.('changeReason')} hint="Shown on the timeline; the amount never is.">
        <input value={form.changeReason} onChange={(e) => set('changeReason', e.target.value)} placeholder="Annual increment" required />
      </FormField>
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="button button-primary" type="submit" disabled={saving}>
          {saving && <Spinner size={15} />} Save change
        </button>
      </div>
    </form>
  )
}

function AdvancesTab({ employee, self }) {
  const advances = useResource(() => fetchAdvances(self ? {} : { employeeId: employee.id }), [employee.id, self])
  return (
    <Async loading={advances.loading} error={advances.error} onRetry={advances.reload} rows={3}>
      <DataTable
        columns={[
          { key: 'reference', label: 'Reference', primary: true, render: (row) => <strong>{row.reference}</strong> },
          { key: 'requestDate', label: 'Requested', render: (row) => formatDate(row.requestDate) },
          { key: 'originalAmount', label: 'Amount', className: 'num', render: (row) => <Money value={row.originalAmount} currency={row.currency} /> },
          { key: 'repaidAmount', label: 'Repaid', className: 'num', render: (row) => <Money value={row.repaidAmount} currency={row.currency} /> },
          { key: 'remainingAmount', label: 'Remaining', className: 'num', render: (row) => <Money value={row.remainingAmount} currency={row.currency} /> },
          { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
        ]}
        rows={advances.data?.items ?? []}
        empty={<EmptyMini icon={FileText} title="No salary advances" text="Advances and their repayment appear here." />}
      />
    </Async>
  )
}

function PayrollTab({ employee, self, onToast }) {
  const payslips = useResource(() => fetchPayslips(self ? {} : { employeeId: employee.id }), [employee.id, self])
  const open = async (row) => {
    try {
      await openFile(payslipPdfPath(row.id))
    } catch (error) {
      onToast(error.message, 'error')
    }
  }
  return (
    <Async loading={payslips.loading} error={payslips.error} onRetry={payslips.reload} rows={3}>
      <DataTable
        columns={[
          { key: 'period', label: 'Month', primary: true, render: (row) => <strong>{row.period.name}</strong> },
          { key: 'gross', label: 'Gross', className: 'num', render: (row) => <Money value={row.grossEarnings} currency={row.currency} /> },
          { key: 'deductions', label: 'Deductions', className: 'num', render: (row) => <Money value={row.totalDeductions} currency={row.currency} /> },
          { key: 'net', label: 'Net', className: 'num', render: (row) => <strong><Money value={row.netSalary} currency={row.currency} /></strong> },
          { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.period.status} /> },
          {
            key: 'actions',
            label: '',
            className: 'actions',
            render: (row) =>
              row.hasPayslip ? (
                <button className="button button-secondary button-sm" onClick={() => open(row)}>
                  <ReceiptText size={14} /> Payslip
                </button>
              ) : null,
          },
        ]}
        rows={payslips.data ?? []}
        empty={<EmptyMini icon={ReceiptText} title="No payslips yet" text="Payslips appear once a payroll is approved." />}
      />
    </Async>
  )
}

export function DocumentList({ documents, onToast }) {
  const [letterId, setLetterId] = useState(null)
  const download = async (document) => {
    try {
      await downloadFile(documentDownloadPath(document.id))
    } catch (error) {
      onToast(error.message, 'error')
    }
  }
  return (
    <>
      <DataTable
        columns={[
          {
            key: 'title',
            label: 'Document',
            primary: true,
            render: (row) => (
              <div>
                <strong>{row.title}</strong>
                <small>
                  {humanize(row.category)}
                  {row.isConfidential ? ' · confidential' : ''}
                </small>
              </div>
            ),
          },
          { key: 'issuedOn', label: 'Issued', render: (row) => formatDate(row.issuedOn) },
          {
            key: 'expiresOn',
            label: 'Expires',
            render: (row) =>
              row.expiresOn ? (
                <StatusPill tone={row.isExpired ? 'danger' : row.daysUntilExpiry <= 90 ? 'warning' : 'neutral'} label={formatDate(row.expiresOn)} />
              ) : (
                '—'
              ),
          },
          {
            key: 'actions',
            label: '',
            className: 'actions',
            render: (row) =>
              row.hasStoredFile ? (
                <button className="button button-secondary button-sm" onClick={() => download(row)}>
                  <Download size={14} /> Download
                </button>
              ) : row.category === 'LETTER' ? (
                <button className="button button-secondary button-sm" onClick={() => setLetterId(row.id)}>
                  <FileText size={14} /> Read
                </button>
              ) : (
                <a className="button button-ghost button-sm" href={row.fileUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} /> Open
                </a>
              ),
          },
        ]}
        rows={documents}
        empty={<EmptyState icon={FileText} title="No documents" text="Contracts, visas, certificates and payslips appear here." />}
      />
      <LetterModal documentId={letterId} onClose={() => setLetterId(null)} />
    </>
  )
}

function DocumentsTab({ employee, self, onToast }) {
  const documents = useResource(() => (self ? fetchMyDocuments() : fetchEmployeeDocuments(employee.id)), [employee.id, self])
  return (
    <Async loading={documents.loading} error={documents.error} onRetry={documents.reload} rows={3}>
      <DocumentList documents={documents.data ?? []} onToast={onToast} />
    </Async>
  )
}

function TimelineTab({ employee, self }) {
  const timeline = useResource(() => (self ? fetchMyTimeline() : fetchEmployeeTimeline(employee.id)), [employee.id, self])
  return (
    <Async loading={timeline.loading} error={timeline.error} onRetry={timeline.reload} rows={4}>
      {timeline.data?.length ? (
        <div className="timeline">
          {timeline.data.map((entry) => (
            <div key={entry.id}>
              <i />
              <span>
                <strong>{entry.title}</strong>
                <small>
                  {formatDate(entry.date)}
                  {entry.description ? ` · ${entry.description}` : ''}
                </small>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyMini icon={Clock} title="No history yet" text="Hiring, promotions and changes appear here." />
      )}
    </Async>
  )
}

/** Status changes go through their own audited endpoint; offboarding also ends the login. */
function StatusChangeForm({ employee, onCancel, onSaved }) {
  const [form, setForm] = useState({
    status: employee.statusValue === 'ACTIVE' ? 'ON_LEAVE' : 'ACTIVE',
    effectiveDate: todayIso(),
    reason: '',
    exitReason: '',
  })
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const { submit, saving, error } = useSubmit(async () => {
    await changeEmployeeStatus(employee.id, {
      status: form.status,
      effectiveDate: form.effectiveDate,
      reason: form.reason,
      exitReason: form.status === 'OFFBOARDED' ? form.exitReason : undefined,
    })
    onSaved(`${employee.fullName} is now ${humanize(form.status).toLowerCase()}.`)
  })

  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <p className="muted">
        Current status: <strong>{employee.status}</strong>. The change is written to the timeline and the audit trail.
      </p>
      <div className="two-col">
        <FormField label="New status" error={error?.fieldError?.('status')}>
          <select value={form.status} onChange={(e) => set('status', e.target.value)}>
            {EMPLOYEE_STATUS_OPTIONS.filter((option) => option.value !== employee.statusValue).map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Effective date" error={error?.fieldError?.('effectiveDate')}>
          <input type="date" value={form.effectiveDate} onChange={(e) => set('effectiveDate', e.target.value)} required />
        </FormField>
      </div>
      <FormField label="Reason" error={error?.fieldError?.('reason')}>
        <input value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder="Probation completed" required />
      </FormField>
      {form.status === 'OFFBOARDED' && (
        <FormField label="Exit reason" error={error?.fieldError?.('exitReason')}>
          <input value={form.exitReason} onChange={(e) => set('exitReason', e.target.value)} placeholder="Resignation" required />
        </FormField>
      )}
      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="button button-primary" type="submit" disabled={saving}>
          {saving && <Spinner size={15} />} Save status
        </button>
      </div>
    </form>
  )
}

