import { useState } from 'react'
import { CalendarRange, FileSpreadsheet } from 'lucide-react'
import { Async, DataTable, EmptyState, FilterSelect, Modal, PageHeader, Panel } from '../components/ui.jsx'
import { MonthCalendar } from '../components/attendance.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useResource } from '../hooks/useResource.js'
import { downloadFile } from '../lib/download.js'
import { currentMonthKey, formatHours, formatMinutes, formatMonth, monthBounds, shiftMonthKey, todayIso } from '../lib/format.js'
import { fetchAttendanceSummary, fetchTimesheet, reportPath } from '../api/endpoints.js'
import { WORK_MODE_OPTIONS } from '../data.js'

/** Per-person totals for a month, with each person's calendar one click away. */
export default function TimesheetsPage({ onToast }) {
  const { departments, locations } = useCompany()
  const [month, setMonth] = useState(currentMonthKey())
  const [departmentId, setDepartmentId] = useState('')
  const [workLocationId, setWorkLocationId] = useState('')
  const [workMode, setWorkMode] = useState('')
  const [selected, setSelected] = useState(null)
  const { from, to } = monthBounds(month)

  const filters = {
    from,
    to,
    departmentId: departmentId || undefined,
    workLocationId: workLocationId || undefined,
    workMode: workMode || undefined,
  }
  const summary = useResource(() => fetchAttendanceSummary(filters), [month, departmentId, workLocationId, workMode])

  const exportExcel = async () => {
    try {
      await downloadFile(reportPath('attendance'), { ...filters, format: 'xlsx' })
    } catch (error) {
      onToast(error.message, 'error')
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Timesheets"
        description="Worked hours, lateness, absence and overtime for the month."
        actions={
          <button className="button button-secondary" onClick={exportExcel}>
            <FileSpreadsheet size={15} /> Export to Excel
          </button>
        }
      />
      <Panel flush>
        <div className="toolbar">
          <div className="button-row">
            <button className="button button-secondary button-sm" onClick={() => setMonth(shiftMonthKey(month, -1))} aria-label="Previous month">
              ‹
            </button>
            <strong style={{ minWidth: 130, textAlign: 'center' }}>{formatMonth(month)}</strong>
            <button className="button button-secondary button-sm" onClick={() => setMonth(shiftMonthKey(month, 1))} aria-label="Next month">
              ›
            </button>
          </div>
          <FilterSelect
            label="Department"
            value={departmentId}
            onChange={setDepartmentId}
            options={[{ value: '', label: 'All departments' }, ...departments.map((item) => ({ value: item.id, label: item.name }))]}
          />
          <FilterSelect
            label="Work location"
            value={workLocationId}
            onChange={setWorkLocationId}
            options={[{ value: '', label: 'All locations' }, ...locations.map((item) => ({ value: item.id, label: item.name }))]}
          />
          <FilterSelect label="Work mode" value={workMode} onChange={setWorkMode} options={[{ value: '', label: 'Any mode' }, ...WORK_MODE_OPTIONS]} />
        </div>
        <Async loading={summary.loading} error={summary.error} onRetry={summary.reload} rows={8}>
          <DataTable
            caption="Timesheet summary"
            onRowClick={(row) => setSelected(row.employee)}
            columns={[
              {
                key: 'employee',
                label: 'Employee',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>{row.employee.fullName}</strong>
                    <small>
                      {row.employee.workLocation?.name ?? row.employee.department?.name ?? ''} · {row.timezone}
                    </small>
                  </div>
                ),
              },
              { key: 'scheduled', label: 'Working days', className: 'num', render: (row) => row.totals.scheduledDays },
              { key: 'present', label: 'Present', className: 'num', render: (row) => row.totals.presentDays },
              { key: 'late', label: 'Late', className: 'num', render: (row) => (row.totals.lateDays ? `${row.totals.lateDays} (${formatMinutes(row.totals.lateMinutes)})` : '—') },
              { key: 'absent', label: 'Absent', className: 'num', render: (row) => row.totals.absentDays || '—' },
              { key: 'leave', label: 'Leave', className: 'num', render: (row) => row.totals.leaveDays || '—' },
              { key: 'worked', label: 'Worked (h)', className: 'num', render: (row) => formatHours(row.totals.workedMinutes) },
              { key: 'overtime', label: 'Overtime', className: 'num', render: (row) => (row.totals.overtimeMinutes ? formatMinutes(row.totals.overtimeMinutes) : '—') },
              { key: 'missing', label: 'Open check-ins', className: 'num', render: (row) => row.totals.missingCheckouts || '—' },
            ]}
            rows={summary.data?.rows ?? []}
            rowKey={(row) => row.employee.id}
            empty={<EmptyState icon={CalendarRange} title="Nobody to show" text="Nobody was employed in this month with these filters." />}
          />
        </Async>
      </Panel>
      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.fullName ?? ''} eyebrow={`Timesheet · ${formatMonth(month)}`} size="xl">
        {selected && <EmployeeMonth employeeId={selected.id} from={from} to={to} />}
      </Modal>
    </div>
  )
}

function EmployeeMonth({ employeeId, from, to }) {
  const timesheet = useResource(() => fetchTimesheet({ employeeId, from, to }), [employeeId, from, to])
  return (
    <Async loading={timesheet.loading} error={timesheet.error} onRetry={timesheet.reload} rows={6}>
      {timesheet.data && (
        <div className="page">
          <p className="small muted">
            {timesheet.data.schedule?.name} · times in {timesheet.data.timezone}
          </p>
          <MonthCalendar days={timesheet.data.days} todayKey={todayIso()} />
        </div>
      )}
    </Async>
  )
}
