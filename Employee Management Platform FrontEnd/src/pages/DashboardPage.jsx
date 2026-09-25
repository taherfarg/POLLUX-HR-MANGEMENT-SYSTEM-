import {
  AlarmClock,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  FileWarning,
  HandCoins,
  History,
  Laptop,
  Palmtree,
  UserX,
  UsersRound,
  Wallet,
} from 'lucide-react'
import { Async, EmptyMini, Money, Panel, StatCard, StatusPill } from '../components/ui.jsx'
import { AttendanceStatus } from '../components/attendance.jsx'
import { useResource } from '../hooks/useResource.js'
import { useChangeListener } from '../lib/events.js'
import { formatDate, formatDay, formatMinutes, relativeTime } from '../lib/format.js'
import { fetchDashboard } from '../api/endpoints.js'

/**
 * The HR and administrator dashboard: today first, then what is waiting for a
 * decision, then payroll. Useful numbers, not decorative charts.
 */
export default function DashboardPage({ navigate }) {
  const dashboard = useResource(() => fetchDashboard(), [])
  useChangeListener('attendance', dashboard.reload)

  return (
    <Async loading={dashboard.loading} error={dashboard.error} onRetry={dashboard.reload} rows={8}>
      {dashboard.data && <Dashboard data={dashboard.data} navigate={navigate} />}
    </Async>
  )
}

function Dashboard({ data, navigate }) {
  const cards = data.cards ?? {}
  const approvals = data.pendingApprovals ?? { counts: {} }
  const payroll = data.payroll

  return (
    <div className="page">
      <section className="stat-grid" aria-label="Today at a glance">
        <StatCard icon={UsersRound} label="Total employees" value={cards.totalEmployees} onClick={() => navigate('employees')} />
        <StatCard icon={CheckCircle2} tone="success" label="Present today" value={cards.presentToday} onClick={() => navigate('attendance')} />
        <StatCard icon={UserX} tone="danger" label="Absent today" value={cards.absentToday} hint={cards.notCheckedIn ? `${cards.notCheckedIn} not checked in yet` : undefined} onClick={() => navigate('attendance')} />
        <StatCard icon={AlarmClock} tone="warning" label="Late today" value={cards.lateToday} onClick={() => navigate('attendance')} />
        <StatCard icon={Palmtree} tone="info" label="On leave" value={cards.onLeaveToday} onClick={() => navigate('requests')} />
        <StatCard icon={Laptop} tone="violet" label="Remote employees" value={cards.remoteEmployees} onClick={() => navigate('employees')} />
        <StatCard icon={ClipboardCheck} tone="warning" label="Pending leave requests" value={cards.pendingLeaveRequests} onClick={() => navigate('requests')} />
        <StatCard icon={HandCoins} tone="warning" label="Pending advance requests" value={cards.pendingSalaryAdvances} onClick={() => navigate('advances')} />
      </section>

      <div className="grid-main-side">
        <Panel
          title="Today's attendance"
          description={data.todayAttendance ? `${data.todayAttendance.total} people scheduled or checked in, in their own timezone` : undefined}
          actions={
            <button className="button button-secondary button-sm" onClick={() => navigate('attendance')}>
              Open attendance
            </button>
          }
          flush
        >
          <div className="panel-body">
            {data.todayAttendance?.rows?.length ? (
              <div className="list">
                {data.todayAttendance.rows.map((row) => (
                  <div className="list-row" key={row.employee.id}>
                    <div className="grow">
                      <strong className="truncate">{row.employee.fullName}</strong>
                      <small className="truncate">
                        {row.employee.department?.name ?? 'No department'} · {row.employee.workLocation?.name ?? 'No location'}
                      </small>
                    </div>
                    <span className="small muted nowrap">
                      {row.checkInLocal ? `In ${row.checkInLocal}` : row.scheduledStartLocal && row.status !== 'NOT_TRACKED' ? `Due ${row.scheduledStartLocal}` : ''}
                    </span>
                    <AttendanceStatus day={row} />
                  </div>
                ))}
              </div>
            ) : (
              <EmptyMini icon={Clock} title="Nobody is scheduled right now" text="Rest days and holidays are quiet." />
            )}
          </div>
        </Panel>

        <Panel title="Pending approvals" description={`${approvals.total ?? 0} waiting`} flush>
          <div className="panel-body">
            <div className="list">
              <ApprovalRow label="Leave requests" count={approvals.counts.leaveRequests} onClick={() => navigate('requests')} />
              <ApprovalRow label="Document & profile requests" count={approvals.counts.otherRequests} onClick={() => navigate('requests')} />
              <ApprovalRow label="Salary advances" count={approvals.counts.salaryAdvances} onClick={() => navigate('advances')} />
              <ApprovalRow label="Overtime" count={approvals.counts.overtime} onClick={() => navigate('overtime')} />
              <ApprovalRow label="Bonuses & deductions" count={approvals.counts.payrollAdjustments} onClick={() => navigate('adjustments')} />
              <ApprovalRow label="Payroll awaiting approval" count={approvals.counts.payrollAwaitingApproval} onClick={() => navigate('payroll')} />
            </div>
            {approvals.leaveRequests?.length > 0 && (
              <>
                <p className="eyebrow" style={{ marginTop: 14 }}>
                  Oldest leave requests
                </p>
                <div className="list">
                  {approvals.leaveRequests.map((request) => (
                    <button className="list-row" key={request.id} onClick={() => navigate('requests', request.id)}>
                      <div className="grow">
                        <strong className="truncate">{request.employee.fullName}</strong>
                        <small>
                          {request.leaveType?.name} · {formatDate(request.startDate, { year: undefined })} – {formatDate(request.endDate, { year: undefined })}
                        </small>
                      </div>
                      <span className="small muted">{relativeTime(request.submittedAt)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="Missing check-outs" description="Check-ins left open past the end of the shift." flush>
          <div className="panel-body">
            {data.missingCheckouts?.length ? (
              <div className="list">
                {data.missingCheckouts.map((entry) => (
                  <button className="list-row" key={entry.recordId} onClick={() => navigate('attendance')}>
                    <div className="grow">
                      <strong>{entry.employee.fullName}</strong>
                      <small>
                        {formatDay(entry.date)} · checked in {entry.checkInLocal} ({entry.timezone})
                      </small>
                    </div>
                    <StatusPill status="MISSING_CHECKOUT" label="Missing check-out" />
                  </button>
                ))}
              </div>
            ) : (
              <EmptyMini icon={CheckCircle2} title="No open check-ins" text="Everyone who checked in has checked out." />
            )}
          </div>
        </Panel>

        <Panel title="Upcoming document expiry" description="Visas, IDs and permits in the next 90 days." flush>
          <div className="panel-body">
            {data.alerts?.expiringDocuments?.length ? (
              <div className="list">
                {data.alerts.expiringDocuments.slice(0, 8).map((document) => (
                  <button className="list-row" key={document.documentId} onClick={() => navigate('documents')}>
                    <div className="grow">
                      <strong className="truncate">{document.title}</strong>
                      <small>{document.employee.fullName}</small>
                    </div>
                    <StatusPill tone={document.daysRemaining <= 30 ? 'danger' : 'warning'} label={`${document.daysRemaining} days`} />
                  </button>
                ))}
              </div>
            ) : (
              <EmptyMini icon={FileWarning} title="Nothing expiring soon" text="No document expires in the next 90 days." />
            )}
          </div>
        </Panel>
      </div>

      <div className="grid-2">
        {payroll && (
          <Panel
            title="Payroll"
            description="Visible to HR and administrators only."
            actions={
              <button className="button button-secondary button-sm" onClick={() => navigate('payroll')}>
                Payroll runs
              </button>
            }
          >
            <div className="list">
              {payroll.current && (
                <button className="list-row" onClick={() => navigate('payroll', payroll.current.id)}>
                  <div className="grow">
                    <strong>{payroll.current.name}</strong>
                    <small>
                      {payroll.current.employeeCount} employees · net <Money value={payroll.current.totalNet} currency={payroll.current.currency} />
                    </small>
                  </div>
                  <StatusPill status={payroll.current.status} />
                </button>
              )}
              {payroll.lastPaid && (
                <button className="list-row" onClick={() => navigate('payroll', payroll.lastPaid.id)}>
                  <div className="grow">
                    <strong>{payroll.lastPaid.name}</strong>
                    <small>
                      Paid {formatDate(payroll.lastPaid.payDate)} · net <Money value={payroll.lastPaid.totalNet} currency={payroll.lastPaid.currency} />
                    </small>
                  </div>
                  <StatusPill status="PAID" />
                </button>
              )}
              {payroll.outstandingAdvances?.map((entry) => (
                <button className="list-row" key={entry.currency} onClick={() => navigate('advances')}>
                  <div className="grow">
                    <strong>Salary advances outstanding</strong>
                    <small>Still to be repaid through payroll</small>
                  </div>
                  <Money value={entry.amount} currency={entry.currency} />
                </button>
              ))}
              {!payroll.current && !payroll.lastPaid && (
                <EmptyMini icon={Wallet} title="No payroll yet" text="Create the first payroll run from Payroll runs." />
              )}
            </div>
          </Panel>
        )}

        <Panel title="Recent HR activity" description="From the audit trail." flush>
          <div className="panel-body">
            {data.recentActivity?.length ? (
              <div className="list">
                {data.recentActivity.map((entry) => (
                  <div className="list-row" key={entry.id}>
                    <History size={16} className="muted" />
                    <div className="grow">
                      <strong className="truncate" style={{ fontWeight: 500 }}>
                        {entry.summary}
                      </strong>
                      <small>
                        {entry.actorLabel} · {relativeTime(entry.createdAt)}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyMini icon={History} title="No activity yet" text="Changes appear here as people use the system." />
            )}
          </div>
        </Panel>
      </div>

      {(data.alerts?.probationEnding?.length > 0 || data.alerts?.contractsEnding?.length > 0) && (
        <Panel title="Coming up" description="Probation reviews and contract renewals.">
          <div className="list">
            {data.alerts.probationEnding.map((entry) => (
              <button className="list-row" key={`p-${entry.employee.id}`} onClick={() => navigate('employees', entry.employee.id)}>
                <CalendarClock size={16} className="muted" />
                <div className="grow">
                  <strong>{entry.employee.fullName}</strong>
                  <small>Probation ends {formatDate(entry.date)}</small>
                </div>
                <span className="small muted">{entry.daysRemaining} days</span>
              </button>
            ))}
            {data.alerts.contractsEnding.map((entry) => (
              <button className="list-row" key={`c-${entry.employee.id}`} onClick={() => navigate('employees', entry.employee.id)}>
                <CalendarClock size={16} className="muted" />
                <div className="grow">
                  <strong>{entry.employee.fullName}</strong>
                  <small>Contract ends {formatDate(entry.date)}</small>
                </div>
                <span className="small muted">{entry.daysRemaining} days</span>
              </button>
            ))}
          </div>
        </Panel>
      )}

      {data.self?.attendanceToday?.today?.workedMinutes > 0 && (
        <p className="small muted">You have worked {formatMinutes(data.self.attendanceToday.today.workedMinutes)} today.</p>
      )}
    </div>
  )
}

function ApprovalRow({ label, count, onClick }) {
  return (
    <button className="list-row" onClick={onClick}>
      <div className="grow">
        <strong style={{ fontWeight: 500 }}>{label}</strong>
      </div>
      {count ? <span className="count-badge">{count}</span> : <span className="small muted">None</span>}
    </button>
  )
}
