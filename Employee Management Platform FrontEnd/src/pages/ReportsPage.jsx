import { useEffect, useMemo, useState } from 'react'
import { BarChart3, FileDown, FileSpreadsheet, FileText, LockKeyhole, Play } from 'lucide-react'
import { Async, DataTable, EmptyState, FilterSelect, PageHeader, Panel, Spinner } from '../components/ui.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useResource } from '../hooks/useResource.js'
import { downloadFile } from '../lib/download.js'
import { formatAmount, formatDate, monthBounds, currentMonthKey, todayIso } from '../lib/format.js'
import { fetchEmployees, fetchPayrollPeriods, fetchReportCatalog, reportPath, runReport } from '../api/endpoints.js'
import { EMPLOYEE_STATUS_OPTIONS, WORK_MODE_OPTIONS } from '../data.js'

const STATUS_OPTIONS = {
  overtime: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
  leave: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
  payroll: ['DRAFT', 'CALCULATED', 'REVIEWED', 'APPROVED', 'PAID'],
  advances: ['PENDING', 'APPROVED', 'PAID', 'ACTIVE', 'COMPLETED', 'REJECTED', 'CANCELLED'],
}

/**
 * Reports: pick one, set the filters, preview, export. The API decides what
 * each role may run - a manager gets team attendance and leave reports, never
 * pay - and records every export.
 */
export default function ReportsPage({ session, onToast }) {
  const catalog = useResource(() => fetchReportCatalog(), [])
  const [type, setType] = useState(null)

  useEffect(() => {
    if (!type && catalog.data?.length) setType(catalog.data[0].type)
  }, [catalog.data, type])

  const definition = catalog.data?.find((report) => report.type === type)

  return (
    <div className="page">
      <PageHeader title="Reports" description={session.isManagement ? 'Preview on screen, then export as CSV, Excel or PDF. Exports are recorded in the audit trail.' : 'Reports for you and your team.'} />
      <Async loading={catalog.loading} error={catalog.error} onRetry={catalog.reload} rows={3}>
        <div className="report-cards">
          {(catalog.data ?? []).map((report) => (
            <button key={report.type} className={`report-card ${report.type === type ? 'active' : ''}`} onClick={() => setType(report.type)} aria-pressed={report.type === type}>
              <strong>
                {report.title} {report.sensitive && <LockKeyhole size={13} aria-label="Contains pay data" />}
              </strong>
              <small>{report.description}</small>
            </button>
          ))}
        </div>
      </Async>
      {definition && <ReportRunner key={definition.type} definition={definition} session={session} onToast={onToast} />}
    </div>
  )
}

function ReportRunner({ definition, session, onToast }) {
  const { departments, locations } = useCompany()
  const month = monthBounds(currentMonthKey())
  const longRange = ['leave', 'overtime', 'payroll', 'advances'].includes(definition.type)
  const [filters, setFilters] = useState({
    from: longRange ? `${new Date().getFullYear()}-01-01` : month.from,
    to: longRange ? `${new Date().getFullYear()}-12-31` : todayIso() < month.to ? todayIso() : month.to,
    year: String(new Date().getFullYear()),
    employeeId: '',
    departmentId: '',
    workLocationId: '',
    workMode: '',
    status: '',
    periodId: '',
  })
  const [result, setResult] = useState(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [exporting, setExporting] = useState(null)
  const has = (name) => definition.filters.includes(name)
  const set = (key, value) => setFilters((state) => ({ ...state, [key]: value }))

  const people = useResource(() => (has('employee') ? fetchEmployees({ pageSize: 100, sortBy: 'name' }) : Promise.resolve(null)), [])
  const periods = useResource(() => (has('period') ? fetchPayrollPeriods() : Promise.resolve([])), [])

  const query = useMemo(() => {
    const params = {}
    if (has('range') && !(has('period') && filters.periodId)) {
      params.from = filters.from
      params.to = filters.to
    }
    if (has('year')) params.year = filters.year
    for (const key of ['employeeId', 'departmentId', 'workLocationId', 'workMode', 'status', 'periodId']) {
      if (filters[key]) params[key] = filters[key]
    }
    return params
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, definition.type])

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      setResult(await runReport(definition.type, query))
    } catch (caught) {
      setError(caught)
      setResult(null)
    } finally {
      setRunning(false)
    }
  }

  const exportAs = async (format) => {
    setExporting(format)
    try {
      const name = await downloadFile(reportPath(definition.type), { ...query, format })
      onToast(`${name} downloaded.`)
    } catch (caught) {
      onToast(caught.message, 'error')
    } finally {
      setExporting(null)
    }
  }

  const statusOptions = definition.type === 'employees' ? [...EMPLOYEE_STATUS_OPTIONS, { value: 'ALL', label: 'Everyone, incl. offboarded' }] : (STATUS_OPTIONS[definition.type] ?? []).map((value) => ({ value, label: value.charAt(0) + value.slice(1).toLowerCase() }))

  return (
    <Panel
      title={definition.title}
      description={definition.teamOnly ? 'Limited to you and your direct reports.' : definition.description}
      actions={
        <>
          <button className="button button-primary" onClick={run} disabled={running}>
            {running ? <Spinner size={15} /> : <Play size={15} />} Preview
          </button>
          <button className="button button-secondary" onClick={() => exportAs('csv')} disabled={Boolean(exporting)}>
            {exporting === 'csv' ? <Spinner size={15} /> : <FileDown size={15} />} CSV
          </button>
          <button className="button button-secondary" onClick={() => exportAs('xlsx')} disabled={Boolean(exporting)}>
            {exporting === 'xlsx' ? <Spinner size={15} /> : <FileSpreadsheet size={15} />} Excel
          </button>
          <button className="button button-secondary" onClick={() => exportAs('pdf')} disabled={Boolean(exporting)}>
            {exporting === 'pdf' ? <Spinner size={15} /> : <FileText size={15} />} PDF
          </button>
        </>
      }
      flush
    >
      <div className="toolbar">
        {has('range') && (
          <>
            <label className="filter-label">
              From
              <input className="filter-date" type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} aria-label="From date" />
            </label>
            <label className="filter-label">
              To
              <input className="filter-date" type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} aria-label="To date" />
            </label>
          </>
        )}
        {has('year') && (
          <FilterSelect
            label="Year"
            value={filters.year}
            onChange={(value) => set('year', value)}
            options={[-1, 0, 1].map((offset) => String(new Date().getFullYear() + offset)).map((value) => ({ value, label: value }))}
          />
        )}
        {has('period') && (
          <FilterSelect
            label="Payroll month"
            value={filters.periodId}
            onChange={(value) => set('periodId', value)}
            options={[{ value: '', label: 'All months in range' }, ...(periods.data ?? []).map((period) => ({ value: period.id, label: period.name }))]}
          />
        )}
        {has('employee') && (
          <FilterSelect
            label="Employee"
            value={filters.employeeId}
            onChange={(value) => set('employeeId', value)}
            options={[{ value: '', label: 'Everyone' }, ...(people.data?.items ?? []).map((person) => ({ value: person.id, label: person.fullName }))]}
          />
        )}
        {has('department') && (
          <FilterSelect
            label="Department"
            value={filters.departmentId}
            onChange={(value) => set('departmentId', value)}
            options={[{ value: '', label: 'All departments' }, ...departments.map((item) => ({ value: item.id, label: item.name }))]}
          />
        )}
        {has('workLocation') && (
          <FilterSelect
            label="Work location"
            value={filters.workLocationId}
            onChange={(value) => set('workLocationId', value)}
            options={[{ value: '', label: 'All locations' }, ...locations.map((item) => ({ value: item.id, label: item.name }))]}
          />
        )}
        {has('workMode') && (
          <FilterSelect label="Work mode" value={filters.workMode} onChange={(value) => set('workMode', value)} options={[{ value: '', label: 'Any mode' }, ...WORK_MODE_OPTIONS]} />
        )}
        {has('status') && statusOptions.length > 0 && (
          <FilterSelect label="Status" value={filters.status} onChange={(value) => set('status', value)} options={[{ value: '', label: 'Any status' }, ...statusOptions]} />
        )}
      </div>
      {error && <Async error={error} />}
      {!result && !error && (
        <EmptyState icon={BarChart3} title="Set the filters and preview" text="Or export straight away - the file uses the same filters." />
      )}
      {result && (
        <>
          <div className="panel-body small muted">{result.subtitle}</div>
          <DataTable
            caption={result.title}
            rowKey={(row) => JSON.stringify(row)}
            columns={result.columns.map((column, index) => ({
              key: column.key,
              label: column.label,
              primary: index === 0,
              className: ['money', 'number', 'minutes'].includes(column.type) ? 'num' : undefined,
              render: (row) => formatCell(row[column.key], column.type),
            }))}
            rows={result.rows.slice(0, 500)}
            empty={<EmptyState icon={BarChart3} title="No rows" text="Nothing matches these filters." />}
          />
          {result.rows.length > 500 && <div className="panel-footer">Showing the first 500 of {result.rows.length} rows. Export for everything.</div>}
          {result.summary.length > 0 && (
            <div className="summary-strip">
              {result.summary.map((entry) => (
                <span key={entry.label}>
                  {entry.label}
                  <strong>{entry.value}</strong>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  )
}

function formatCell(value, type) {
  if (value === null || value === undefined || value === '') return '—'
  if (type === 'money') return formatAmount(value)
  if (type === 'date') return formatDate(value)
  return String(value)
}
