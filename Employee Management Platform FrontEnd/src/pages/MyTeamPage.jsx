import { UsersRound } from 'lucide-react'
import { Async, Avatar, Chip, DataTable, EmptyState, PageHeader, Panel } from '../components/ui.jsx'
import { AttendanceStatus } from '../components/attendance.jsx'
import EmployeeProfile from '../components/EmployeeProfile.jsx'
import { useResource } from '../hooks/useResource.js'
import { fetchAttendanceBoard, fetchMyTeam } from '../api/endpoints.js'

/** A manager's direct reports - working context and attendance, never pay. */
export default function MyTeamPage({ session, param, navigate, onToast }) {
  const team = useResource(() => fetchMyTeam(), [])
  const board = useResource(() => fetchAttendanceBoard().catch(() => null), [])

  if (param) {
    return <EmployeeProfile employeeId={param} session={session} onBack={() => navigate('my-team')} onToast={onToast} />
  }

  const today = new Map((board.data?.rows ?? []).map((row) => [row.employee.id, row]))

  return (
    <div className="page">
      <PageHeader title="My team" description="Your direct reports. Salary and payroll stay with HR and each employee." />
      <Panel flush>
        <Async loading={team.loading} error={team.error} onRetry={team.reload} rows={5}>
          <DataTable
            caption="My team"
            onRowClick={(row) => navigate('my-team', row.id)}
            columns={[
              {
                key: 'name',
                label: 'Employee',
                primary: true,
                render: (row) => (
                  <div className="person-cell">
                    <Avatar employee={row} size="sm" />
                    <span>
                      <strong>{row.fullName}</strong>
                      <small>{row.role}</small>
                    </span>
                  </div>
                ),
              },
              {
                key: 'where',
                label: 'Works from',
                render: (row) => (
                  <div className="button-row">
                    {row.workLocationName && <Chip>{row.workLocationName}</Chip>}
                    <Chip>{row.workMode}</Chip>
                  </div>
                ),
              },
              { key: 'timezone', label: 'Timezone', render: (row) => row.effectiveTimezone ?? '—' },
              { key: 'phone', label: 'Phone', render: (row) => row.phone ?? '—' },
              {
                key: 'today',
                label: 'Today',
                render: (row) => (today.get(row.id) ? <AttendanceStatus day={today.get(row.id)} /> : '—'),
              },
            ]}
            rows={team.data ?? []}
            empty={<EmptyState icon={UsersRound} title="No direct reports" text="People who report to you appear here." />}
          />
        </Async>
      </Panel>
    </div>
  )
}
