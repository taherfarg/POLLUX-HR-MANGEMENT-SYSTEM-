import { useState } from 'react'
import { Clock } from 'lucide-react'
import { Async, DataTable, EmptyState, Panel, StatCard } from '../components/ui.jsx'
import { AttendanceStatus, CheckInCard, MonthCalendar } from '../components/attendance.jsx'
import { useResource } from '../hooks/useResource.js'
import { useChangeListener } from '../lib/events.js'
import { currentMonthKey, formatDay, formatMinutes, formatMonth, monthBounds, shiftMonthKey, todayIso } from '../lib/format.js'
import { fetchMyAttendance } from '../api/endpoints.js'

/** Check in and out, and see every day of the month as HR sees it. */
export default function MyAttendancePage({ onToast }) {
  const [month, setMonth] = useState(currentMonthKey())
  const [view, setView] = useState('calendar')
  const { from, to } = monthBounds(month)
  const history = useResource(() => fetchMyAttendance({ from, to }), [month])
  useChangeListener('attendance', history.reload)
  const totals = history.data?.totals
  const days = (history.data?.days ?? []).filter((day) => day.status !== 'NOT_EMPLOYED')

  return (
    <div className="page">
      <CheckInCard onToast={onToast} />
      <Panel
        title={formatMonth(month)}
        description={history.data ? `${history.data.schedule?.name ?? ''} · times in ${history.data.timezone}` : undefined}
        actions={
          <div className="button-row">
            <button className="button button-secondary button-sm" onClick={() => setMonth(shiftMonthKey(month, -1))} aria-label="Previous month">
              ‹
            </button>
            <button className="button button-secondary button-sm" onClick={() => setMonth(shiftMonthKey(month, 1))} aria-label="Next month">
              ›
            </button>
            <button className="button button-ghost button-sm" onClick={() => setView(view === 'calendar' ? 'list' : 'calendar')}>
              {view === 'calendar' ? 'List view' : 'Calendar view'}
            </button>
          </div>
        }
      >
        <Async loading={history.loading} error={history.error} onRetry={history.reload} rows={6}>
          <div className="page">
            {totals && (
              <section className="stat-grid">
                <StatCard label="Present days" value={totals.presentDays} tone="success" />
                <StatCard label="Late arrivals" value={totals.lateDays} hint={totals.lateMinutes ? formatMinutes(totals.lateMinutes) : undefined} tone="warning" />
                <StatCard label="Absent days" value={totals.absentDays} tone="danger" />
                <StatCard label="Worked" value={formatMinutes(totals.workedMinutes)} />
                <StatCard label="Overtime" value={formatMinutes(totals.overtimeMinutes)} tone="violet" />
              </section>
            )}
            {view === 'calendar' ? (
              <MonthCalendar days={history.data?.days ?? []} todayKey={todayIso()} />
            ) : (
              <DataTable
                caption="My attendance"
                rowKey={(row) => row.date}
                columns={[
                  { key: 'date', label: 'Day', primary: true, render: (row) => <strong>{formatDay(row.date)}</strong> },
                  { key: 'in', label: 'In', render: (row) => row.checkInLocal ?? '—' },
                  { key: 'out', label: 'Out', render: (row) => row.checkOutLocal ?? '—' },
                  { key: 'worked', label: 'Worked', className: 'num', render: (row) => (row.workedMinutes ? formatMinutes(row.workedMinutes) : '—') },
                  { key: 'late', label: 'Late', className: 'num', render: (row) => (row.lateMinutes ? formatMinutes(row.lateMinutes) : '—') },
                  { key: 'overtime', label: 'Overtime', className: 'num', render: (row) => (row.overtimeMinutes ? formatMinutes(row.overtimeMinutes) : '—') },
                  { key: 'status', label: 'Status', render: (row) => <AttendanceStatus day={row} /> },
                ]}
                rows={days.filter((day) => day.date <= todayIso())}
                empty={<EmptyState icon={Clock} title="No days yet" />}
              />
            )}
          </div>
        </Async>
      </Panel>
    </div>
  )
}
