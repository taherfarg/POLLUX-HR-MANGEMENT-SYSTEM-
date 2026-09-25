import { useEffect, useState } from 'react'
import { Plus, UsersRound } from 'lucide-react'
import {
  Async,
  Avatar,
  Chip,
  DataTable,
  EmptyState,
  FilterSelect,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  SearchInput,
  StatusPill,
} from '../components/ui.jsx'
import EmployeeForm from '../components/EmployeeForm.jsx'
import EmployeeProfile from '../components/EmployeeProfile.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useDebouncedValue, useResource } from '../hooks/useResource.js'
import { formatDate } from '../lib/format.js'
import { fetchEmployees } from '../api/endpoints.js'
import { EMPLOYEE_STATUS_OPTIONS, WORK_MODE_OPTIONS } from '../data.js'

const PAGE_SIZE = 20

/** The employee list, or one employee's profile when the URL names them. */
export default function EmployeesPage({ session, param, navigate, onToast }) {
  if (param) {
    return <EmployeeProfile employeeId={param} session={session} onBack={() => navigate('employees')} onToast={onToast} />
  }
  return <EmployeeList session={session} navigate={navigate} onToast={onToast} />
}

function EmployeeList({ session, navigate, onToast }) {
  const { departments, locations } = useCompany()
  const [query, setQuery] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [workLocationId, setWorkLocationId] = useState('')
  const [workMode, setWorkMode] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState('name')
  const [page, setPage] = useState(1)
  const [adding, setAdding] = useState(false)
  const debouncedQuery = useDebouncedValue(query, 300)

  useEffect(() => setPage(1), [debouncedQuery, departmentId, workLocationId, workMode, status, sort])

  const directory = useResource(
    () =>
      fetchEmployees({
        q: debouncedQuery,
        departmentId: departmentId || undefined,
        workLocationId: workLocationId || undefined,
        workMode: workMode || undefined,
        status: status || undefined,
        includeOffboarded: status === 'OFFBOARDED',
        sortBy: sort === 'joined' ? 'hireDate' : sort,
        sortOrder: sort === 'joined' ? 'desc' : 'asc',
        page,
        pageSize: PAGE_SIZE,
      }),
    [debouncedQuery, departmentId, workLocationId, workMode, status, sort, page],
  )

  const employees = directory.data?.items ?? []
  const meta = directory.data?.meta

  return (
    <div className="page">
      <PageHeader
        title="Employees"
        description={meta ? `${meta.total} ${meta.total === 1 ? 'person' : 'people'}` : undefined}
        actions={
          session.isManagement && (
            <button className="button button-primary" onClick={() => setAdding(true)}>
              <Plus size={16} /> Add employee
            </button>
          )
        }
      />

      <Panel flush>
        <div className="toolbar">
          <SearchInput value={query} onChange={setQuery} placeholder="Name, number, email or job title" label="Search employees" />
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
          <FilterSelect label="Status" value={status} onChange={setStatus} options={[{ value: '', label: 'Current employees' }, ...EMPLOYEE_STATUS_OPTIONS]} />
          <FilterSelect
            label="Sort"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'name', label: 'Sort: name' },
              { value: 'joined', label: 'Sort: newest' },
              { value: 'jobTitle', label: 'Sort: job title' },
              { value: 'employeeNumber', label: 'Sort: number' },
            ]}
          />
        </div>

        <Async loading={directory.loading} error={directory.error} onRetry={directory.reload} rows={8}>
          <DataTable
            caption="Employees"
            onRowClick={(row) => navigate('employees', row.id)}
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
                      <small>
                        {row.employeeNumber} · {row.email}
                      </small>
                    </span>
                  </div>
                ),
              },
              {
                key: 'role',
                label: 'Job',
                render: (row) => (
                  <div>
                    <strong>{row.role}</strong>
                    <small>{row.department}</small>
                  </div>
                ),
              },
              {
                key: 'location',
                label: 'Works from',
                render: (row) => (
                  <div className="button-row">
                    {row.workLocationName && <Chip>{row.workLocationName}</Chip>}
                    <Chip>{row.workMode}</Chip>
                  </div>
                ),
              },
              { key: 'manager', label: 'Manager', render: (row) => row.managerName ?? '—' },
              { key: 'joined', label: 'Joined', render: (row) => (row.joinDate ? formatDate(row.joinDate) : '—') },
              { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.statusValue} label={row.status} /> },
            ]}
            rows={employees}
            empty={<EmptyState icon={UsersRound} title="No employees found" text="Try another search or clear the filters." />}
          />
          <Pagination meta={meta} onPage={setPage} />
        </Async>
      </Panel>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add an employee" eyebrow="People" size="lg">
        <EmployeeForm
          session={session}
          onCancel={() => setAdding(false)}
          onSaved={(message, employee) => {
            setAdding(false)
            directory.reload()
            onToast(message)
            if (employee?.id) navigate('employees', employee.id)
          }}
          onToast={onToast}
        />
      </Modal>
    </div>
  )
}
