import { useState } from 'react'
import { AlarmClock, CalendarPlus, CheckCircle2, ClipboardCheck, FileText, HandCoins, Palmtree, ReceiptText, UserX, UsersRound } from 'lucide-react'
import { Async, EmptyMini, Money, Panel, StatCard, StatusPill } from '../components/ui.jsx'
import { AttendanceStatus, CheckInCard } from '../components/attendance.jsx'
import { BalanceCards } from '../components/leave.jsx'
import RequestFormModal from '../components/RequestFormModal.jsx'
import { useResource } from '../hooks/useResource.js'
import { useChangeListener } from '../lib/events.js'
import { openFile } from '../lib/download.js'
import { formatDate, formatMinutes, formatMonth, relativeTime } from '../lib/format.js'
import { fetchDashboard, fetchMyBalances, payslipPdfPath } from '../api/endpoints.js'

/**
 * Home for employees and managers: check in, time off, pay - and for a
 * manager, the team's day and the decisions waiting for them. A manager sees
 * the team's attendance and requests, never their pay.
 */
export default function HomePage({ session, navigate, onToast }) {
  const dashboard = useResource(() => fetchDashboard(), [])
  const balances = useResource(() => fetchMyBalances(), [])
  const [requestType, setRequestType] = useState(null)
  useChangeListener('attendance', dashboard.reload)

  const data = dashboard.data

  return (
    <div className="page">
      <div className="grid-main-side">
        <div className="page">
          {session.employee && <CheckInCard onToast={onToast} />}
          <Panel
            title="Time off"
            description={`Leave balances for ${new Date().getFullYear()}`}
            actions={
              <button className="button button-primary button-sm" onClick={() => setRequestType('Leave')}>
                <CalendarPlus size={15} /> Request leave
              </button>
            }
          >
            <Async loading={balances.loading} error={balances.error} onRetry={balances.reload} rows={2}>
              <BalanceCards balances={balances.data} limit={3} />
            </Async>
          </Panel>
        </div>

        <div className="page">
          <Async loading={dashboard.loading} error={dashboard.error} onRetry={dashboard.reload} rows={4}>
            {data && (
              <>
                <PayPanel pay={data.pay} navigate={navigate} onToast={onToast} />
                <Panel title="Coming up">
                  <div className="list">
                    {(data.upcomingLeave ?? []).map((leave) => (
                      <div className="list-row" key={leave.requestId}>
                        <Palmtree size={16} className="muted" />
                        <div className="grow">
                          <strong>{leave.leaveType?.name}</strong>
                          <small>
                            {formatDate(leave.startDate, { year: undefined })} – {formatDate(leave.endDate, { year: undefined })} · {leave.workingDays} days
                          </small>
                        </div>
                        <StatusPill status="APPROVED" />
                      </div>
                    ))}
                    {(data.pendingRequests ?? []).map((request) => (
                      <button className="list-row" key={request.id} onClick={() => navigate('my-requests')}>
                        <ClipboardCheck size={16} className="muted" />
                        <div className="grow">
                          <strong>{request.reference}</strong>
                          <small>Submitted {relativeTime(request.submittedAt)}</small>
                        </div>
                        <StatusPill status="PENDING" />
                      </button>
                    ))}
                    {(data.upcomingHolidays ?? []).map((holiday) => (
                      <div className="list-row" key={holiday.date}>
                        <CalendarPlus size={16} className="muted" />
                        <div className="grow">
                          <strong>{holiday.name}</strong>
                          <small>{formatDate(holiday.date, { weekday: 'short' })}</small>
                        </div>
                        <StatusPill status="HOLIDAY" label="Holiday" />
                      </div>
                    ))}
                    {!data.upcomingLeave?.length && !data.pendingRequests?.length && !data.upcomingHolidays?.length && (
                      <EmptyMini icon={CheckCircle2} title="Nothing scheduled" text="Approved leave and upcoming holidays appear here." />
                    )}
                  </div>
                </Panel>
              </>
            )}
          </Async>
        </div>
      </div>

      {data?.team && <TeamPanel team={data.team} navigate={navigate} />}

      <RequestFormModal
        type={requestType}
        balances={balances.data ?? []}
        onClose={() => setRequestType(null)}
        onSubmitted={() => {
          setRequestType(null)
          balances.reload()
          dashboard.reload()
        }}
        onToast={onToast}
      />
    </div>
  )
}

function PayPanel({ pay, navigate, onToast }) {
  const payslip = pay?.latestPayslip
  const advance = pay?.activeAdvance

  const open = async () => {
    try {
      await openFile(payslipPdfPath(payslip.recordId))
    } catch (error) {
      onToast(error.message, 'error')
    }
  }

  return (
    <Panel
      title="My pay"
      actions={
        <button className="button button-secondary button-sm" onClick={() => navigate('my-pay')}>
          Payslips &amp; advances
        </button>
      }
    >
      <div className="list">
        {payslip ? (
          <div className="list-row">
            <ReceiptText size={16} className="muted" />
            <div className="grow">
              <strong>{payslip.period}</strong>
              <small>
                Net pay <Money value={payslip.netSalary} currency={payslip.currency} />
                {payslip.payDate ? ` · paid ${formatDate(payslip.payDate)}` : ''}
              </small>
            </div>
            {payslip.hasPdf && (
              <button className="button button-secondary button-sm" onClick={open}>
                <FileText size={14} /> PDF
              </button>
            )}
          </div>
        ) : (
          <EmptyMini icon={ReceiptText} title="No payslip yet" text="Your payslip appears here once payroll is approved." />
        )}
        {advance && (
          <button className="list-row" onClick={() => navigate('my-pay')}>
            <HandCoins size={16} className="muted" />
            <div className="grow">
              <strong>Salary advance {advance.reference}</strong>
              <small>
                <Money value={advance.remainingAmount} currency={advance.currency} /> remaining
                {advance.nextInstallment ? ` · next ${formatMonth(advance.nextInstallment.dueMonth)}` : ''}
              </small>
            </div>
            <StatusPill status={advance.status} />
          </button>
        )}
      </div>
    </Panel>
  )
}

function TeamPanel({ team, navigate }) {
  const cards = team.cards ?? {}
  return (
    <div className="page">
      <section className="stat-grid" aria-label="My team today">
        <StatCard icon={UsersRound} label="Team members" value={cards.teamSize} onClick={() => navigate('my-team')} />
        <StatCard icon={CheckCircle2} tone="success" label="Present today" value={cards.presentToday} onClick={() => navigate('attendance')} />
        <StatCard icon={AlarmClock} tone="warning" label="Late today" value={cards.lateToday} onClick={() => navigate('attendance')} />
        <StatCard icon={UserX} tone="danger" label="Absent today" value={cards.absentToday} onClick={() => navigate('attendance')} />
        <StatCard icon={Palmtree} tone="info" label="On leave" value={cards.onLeaveToday} />
        <StatCard icon={ClipboardCheck} tone="warning" label="Waiting for you" value={cards.pendingApprovals} onClick={() => navigate('requests')} />
      </section>
      <div className="grid-2">
        <Panel title="My team today" flush>
          <div className="panel-body">
            {team.todayAttendance?.rows?.length ? (
              <div className="list">
                {team.todayAttendance.rows.map((row) => (
                  <div className="list-row" key={row.employee.id}>
                    <div className="grow">
                      <strong className="truncate">{row.employee.fullName}</strong>
                      <small>
                        {row.checkInLocal ? `In ${row.checkInLocal}` : row.scheduledStartLocal ? `Due ${row.scheduledStartLocal}` : 'Not scheduled'} ·{' '}
                        {row.timezone}
                        {row.workedMinutes ? ` · ${formatMinutes(row.workedMinutes)}` : ''}
                      </small>
                    </div>
                    <AttendanceStatus day={row} />
                  </div>
                ))}
              </div>
            ) : (
              <EmptyMini icon={UsersRound} title="Nobody scheduled today" text="Your team's check-ins appear here." />
            )}
          </div>
        </Panel>
        <Panel title="Waiting for your decision" flush>
          <div className="panel-body">
            {team.pendingApprovals?.requests?.length || team.pendingApprovals?.overtime?.length ? (
              <div className="list">
                {team.pendingApprovals.requests.map((request) => (
                  <button className="list-row" key={request.id} onClick={() => navigate('requests', request.id)}>
                    <div className="grow">
                      <strong>{request.employee.fullName}</strong>
                      <small>
                        {request.leaveType
                          ? `${request.leaveType.name} · ${formatDate(request.startDate, { year: undefined })} – ${formatDate(request.endDate, { year: undefined })}`
                          : request.reference}
                      </small>
                    </div>
                    <StatusPill status="PENDING" />
                  </button>
                ))}
                {team.pendingApprovals.overtime.map((entry) => (
                  <button className="list-row" key={entry.id} onClick={() => navigate('overtime')}>
                    <div className="grow">
                      <strong>{entry.employee.fullName}</strong>
                      <small>
                        Overtime {formatMinutes(entry.minutes)} on {formatDate(entry.date, { year: undefined })}
                      </small>
                    </div>
                    <StatusPill status="PENDING" />
                  </button>
                ))}
              </div>
            ) : (
              <EmptyMini icon={CheckCircle2} title="You're all caught up" text="Leave and overtime from your team appear here." />
            )}
          </div>
        </Panel>
      </div>
    </div>
  )
}
