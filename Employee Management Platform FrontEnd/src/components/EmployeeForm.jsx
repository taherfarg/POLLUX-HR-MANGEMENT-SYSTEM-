import { useState } from 'react'
import { Check } from 'lucide-react'
import { FormError, FormField, Spinner } from './ui.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useResource } from '../hooks/useResource.js'
import { todayIso } from '../lib/format.js'
import { createEmployee, fetchEmployees, updateEmployee } from '../api/endpoints.js'
import { CONTRACT_TYPE_OPTIONS, EMPLOYMENT_TYPE_OPTIONS, TIMEZONE_OPTIONS, WORK_MODE_OPTIONS } from '../data.js'

/**
 * Create or edit an employee. Status has its own audited endpoint and is only
 * set here for a new hire. Where-and-when fields (location, schedule, holiday
 * calendar, timezone) can each be left empty to follow the company default.
 */
export default function EmployeeForm({ employee, session, onCancel, onSaved, onToast }) {
  const isEdit = Boolean(employee)
  const { departments, locations, schedules, calendars, currency } = useCompany()

  const [form, setForm] = useState(() => ({
    firstName: employee?.firstName ?? '',
    lastName: employee?.lastName ?? '',
    workEmail: employee?.email ?? '',
    personalEmail: employee?.personalEmail ?? '',
    phone: employee?.phone ?? '',
    nationality: employee?.nationality ?? '',
    dateOfBirth: employee?.dateOfBirth ?? '',
    gender: employee?.gender ?? '',
    addressLine: employee?.addressLine ?? '',
    city: employee?.city ?? '',
    country: employee?.country ?? '',
    emergencyContactName: employee?.emergencyContactName ?? '',
    emergencyContactPhone: employee?.emergencyContactPhone ?? '',
    emergencyContactRelation: employee?.emergencyContactRelation ?? '',
    jobTitle: employee?.role ?? '',
    departmentId: employee?.departmentId ?? '',
    managerId: employee?.managerId ?? '',
    employmentType: employee?.employmentTypeValue ?? 'FULL_TIME',
    contractType: employee?.contractTypeValue ?? 'UNLIMITED',
    status: 'PROBATION',
    hireDate: employee?.joinDate ?? todayIso(),
    contractEndDate: employee?.contractEnd ?? '',
    workMode: employee?.workModeValue ?? 'ONSITE',
    workLocationId: employee?.workLocationId ?? '',
    workScheduleId: employee?.workScheduleId ?? '',
    holidayCalendarId: employee?.holidayCalendarId ?? '',
    workCountryCode: employee?.workCountryCode ?? '',
    workCountry: employee?.workCountry ?? '',
    workCity: employee?.workCity ?? '',
    timezone: employee?.timezone ?? '',
    overtimeEligible: employee?.overtimeEligible ?? true,
    attendanceTracked: employee?.attendanceTracked ?? true,
    baseSalary: '',
    housingAllowance: '',
    transportAllowance: '',
    otherAllowances: '',
    createAccount: true,
    accountRole: 'EMPLOYEE',
  }))
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))

  // The manager picker needs everyone, not one page of the directory.
  const managerPool = useResource(() => fetchEmployees({ pageSize: 100, sortBy: 'name' }), [])
  const managerOptions = (managerPool.data?.items ?? []).filter((item) => item.id !== employee?.id)
  const remote = form.workMode === 'REMOTE'

  const optional = (value) => (value === '' ? undefined : value)
  // On edit an emptied reference is sent as null, which clears it.
  const clearable = (value) => (value === '' ? (isEdit ? null : undefined) : value)

  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError(null)

    const common = {
      firstName: form.firstName,
      lastName: form.lastName,
      workEmail: form.workEmail,
      personalEmail: optional(form.personalEmail),
      phone: optional(form.phone),
      nationality: optional(form.nationality),
      dateOfBirth: optional(form.dateOfBirth),
      gender: optional(form.gender),
      addressLine: optional(form.addressLine),
      city: optional(form.city),
      country: optional(form.country),
      emergencyContactName: optional(form.emergencyContactName),
      emergencyContactPhone: optional(form.emergencyContactPhone),
      emergencyContactRelation: optional(form.emergencyContactRelation),
      jobTitle: form.jobTitle,
      departmentId: optional(form.departmentId),
      managerId: optional(form.managerId),
      employmentType: form.employmentType,
      contractType: form.contractType,
      workMode: form.workMode,
      hireDate: form.hireDate,
      contractEndDate: optional(form.contractEndDate),
      workLocationId: clearable(form.workLocationId),
      workScheduleId: clearable(form.workScheduleId),
      holidayCalendarId: clearable(form.holidayCalendarId),
      workCountryCode: clearable(form.workCountryCode.toUpperCase()),
      workCountry: clearable(form.workCountry),
      workCity: clearable(form.workCity),
      timezone: clearable(form.timezone),
      overtimeEligible: form.overtimeEligible,
      attendanceTracked: form.attendanceTracked,
    }

    try {
      if (isEdit) {
        await updateEmployee(employee.id, common)
        onSaved('Employee record updated.')
        return
      }
      const hasPay = form.baseSalary !== ''
      const result = await createEmployee({
        ...common,
        status: form.status,
        compensation: hasPay
          ? {
              baseSalary: Number(form.baseSalary),
              housingAllowance: Number(form.housingAllowance || 0),
              transportAllowance: Number(form.transportAllowance || 0),
              otherAllowances: Number(form.otherAllowances || 0),
              changeReason: 'Starting compensation',
            }
          : undefined,
        account: form.createAccount ? { role: form.accountRole } : undefined,
      })
      onSaved(`${result.employee.fullName} added as ${result.employee.employeeNumber}.`, result.employee)
      // The temporary password is returned exactly once and cannot be read back.
      if (result.temporaryPassword) {
        onToast(`Login created for ${result.employee.email}. Temporary password: ${result.temporaryPassword}`, 'success', { sticky: true })
      }
    } catch (caught) {
      setError(caught)
      setSaving(false)
    }
  }

  const fieldError = (name) => error?.fieldError?.(name)

  return (
    <form className="stack-form" onSubmit={submit} noValidate>
      <section className="form-section">
        <header>
          <h3>Personal details</h3>
          <p>Identity and contact information - visible to HR and the employee only.</p>
        </header>
        <div className="two-col">
          <FormField label="First name" error={fieldError('firstName')}>
            <input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} required />
          </FormField>
          <FormField label="Last name" error={fieldError('lastName')}>
            <input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} required />
          </FormField>
          <FormField label="Work email" error={fieldError('workEmail')}>
            <input type="email" value={form.workEmail} onChange={(e) => set('workEmail', e.target.value)} required />
          </FormField>
          <FormField label="Personal email" error={fieldError('personalEmail')}>
            <input type="email" value={form.personalEmail} onChange={(e) => set('personalEmail', e.target.value)} />
          </FormField>
          <FormField label="Phone" error={fieldError('phone')}>
            <input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+971 50 000 0000" />
          </FormField>
          <FormField label="Nationality">
            <input value={form.nationality} onChange={(e) => set('nationality', e.target.value)} />
          </FormField>
          <FormField label="Date of birth" error={fieldError('dateOfBirth')}>
            <input type="date" value={form.dateOfBirth} onChange={(e) => set('dateOfBirth', e.target.value)} />
          </FormField>
          <FormField label="Gender">
            <select value={form.gender} onChange={(e) => set('gender', e.target.value)}>
              <option value="">Not specified</option>
              <option value="FEMALE">Female</option>
              <option value="MALE">Male</option>
              <option value="UNDISCLOSED">Prefer not to say</option>
            </select>
          </FormField>
          <FormField label="Home address" className="span-2">
            <input value={form.addressLine} onChange={(e) => set('addressLine', e.target.value)} />
          </FormField>
          <FormField label="City">
            <input value={form.city} onChange={(e) => set('city', e.target.value)} />
          </FormField>
          <FormField label="Country">
            <input value={form.country} onChange={(e) => set('country', e.target.value)} />
          </FormField>
          <FormField label="Emergency contact">
            <input value={form.emergencyContactName} onChange={(e) => set('emergencyContactName', e.target.value)} />
          </FormField>
          <FormField label="Emergency phone" error={fieldError('emergencyContactPhone')}>
            <input value={form.emergencyContactPhone} onChange={(e) => set('emergencyContactPhone', e.target.value)} />
          </FormField>
        </div>
      </section>

      <section className="form-section">
        <header>
          <h3>Employment</h3>
        </header>
        <div className="two-col">
          <FormField label="Job title" error={fieldError('jobTitle')}>
            <input value={form.jobTitle} onChange={(e) => set('jobTitle', e.target.value)} required />
          </FormField>
          <FormField label="Department" error={fieldError('departmentId')}>
            <select value={form.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
              <option value="">No department</option>
              {departments.map((department) => (
                <option value={department.id} key={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Manager" error={fieldError('managerId')}>
            <select value={form.managerId} onChange={(e) => set('managerId', e.target.value)}>
              <option value="">No manager</option>
              {managerOptions.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.fullName} — {item.role}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Joining date" error={fieldError('hireDate')}>
            <input type="date" value={form.hireDate} onChange={(e) => set('hireDate', e.target.value)} required />
          </FormField>
          <FormField label="Employment type">
            <select value={form.employmentType} onChange={(e) => set('employmentType', e.target.value)}>
              {EMPLOYMENT_TYPE_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Contract type">
            <select value={form.contractType} onChange={(e) => set('contractType', e.target.value)}>
              {CONTRACT_TYPE_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
          {form.contractType === 'LIMITED' && (
            <FormField label="Contract end" error={fieldError('contractEndDate')}>
              <input type="date" value={form.contractEndDate} onChange={(e) => set('contractEndDate', e.target.value)} />
            </FormField>
          )}
          {!isEdit && (
            <FormField label="Starting status">
              <select value={form.status} onChange={(e) => set('status', e.target.value)}>
                <option value="PROBATION">Probation</option>
                <option value="ACTIVE">Active</option>
              </select>
            </FormField>
          )}
        </div>
      </section>

      <section className="form-section">
        <header>
          <h3>Where and when</h3>
          <p>Leave a field empty to follow the company default (Dubai office hours, UAE holidays).</p>
        </header>
        <div className="two-col">
          <FormField label="Work mode">
            <select value={form.workMode} onChange={(e) => set('workMode', e.target.value)}>
              {WORK_MODE_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Work location" error={fieldError('workLocationId')}>
            <select value={form.workLocationId} onChange={(e) => set('workLocationId', e.target.value)}>
              <option value="">Not set</option>
              {locations.map((location) => (
                <option value={location.id} key={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Work schedule" error={fieldError('workScheduleId')}>
            <select value={form.workScheduleId} onChange={(e) => set('workScheduleId', e.target.value)}>
              <option value="">Company default</option>
              {schedules.map((schedule) => (
                <option value={schedule.id} key={schedule.id}>
                  {schedule.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Holiday calendar" error={fieldError('holidayCalendarId')} hint="Remote colleagues can follow another calendar.">
            <select value={form.holidayCalendarId} onChange={(e) => set('holidayCalendarId', e.target.value)}>
              <option value="">Company default</option>
              {calendars.map((calendar) => (
                <option value={calendar.id} key={calendar.id}>
                  {calendar.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Timezone" error={fieldError('timezone')} hint="Empty: the work location's timezone.">
            <input list="timezone-options" value={form.timezone} onChange={(e) => set('timezone', e.target.value)} placeholder="Asia/Dubai" />
            <datalist id="timezone-options">
              {TIMEZONE_OPTIONS.map((zone) => (
                <option value={zone} key={zone} />
              ))}
            </datalist>
          </FormField>
          {remote && (
            <>
              <FormField label="Country of work" error={fieldError('workCountry')}>
                <input value={form.workCountry} onChange={(e) => set('workCountry', e.target.value)} placeholder="Egypt" />
              </FormField>
              <FormField label="Country code" error={fieldError('workCountryCode')}>
                <input value={form.workCountryCode} maxLength={2} onChange={(e) => set('workCountryCode', e.target.value)} placeholder="EG" />
              </FormField>
              <FormField label="City of work" error={fieldError('workCity')}>
                <input value={form.workCity} onChange={(e) => set('workCity', e.target.value)} placeholder="Cairo" />
              </FormField>
            </>
          )}
        </div>
        <div className="checkbox-row">
          <label className="check">
            <input type="checkbox" checked={form.attendanceTracked} onChange={(e) => set('attendanceTracked', e.target.checked)} />
            Checks in and out (attendance tracked)
          </label>
          <label className="check">
            <input type="checkbox" checked={form.overtimeEligible} onChange={(e) => set('overtimeEligible', e.target.checked)} />
            Eligible for overtime
          </label>
        </div>
      </section>

      {!isEdit && (
        <section className="form-section">
          <header>
            <h3>Pay and login</h3>
            <p>Salary is visible to HR and the employee only - never to their manager.</p>
          </header>
          <div className="two-col">
            <FormField label={`Basic salary (${currency}/month)`} error={fieldError('compensation.baseSalary')} hint="Optional - can be added later">
              <input type="number" min="0" step="0.01" value={form.baseSalary} onChange={(e) => set('baseSalary', e.target.value)} />
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
            <FormField label="Login" hint="A temporary password is shown once after saving">
              <select value={form.createAccount ? 'yes' : 'no'} onChange={(e) => set('createAccount', e.target.value === 'yes')}>
                <option value="yes">Create a login</option>
                <option value="no">No login for now</option>
              </select>
            </FormField>
            {form.createAccount && (
              <FormField label="Role" error={fieldError('account.role')}>
                <select value={form.accountRole} onChange={(e) => set('accountRole', e.target.value)}>
                  <option value="EMPLOYEE">Employee</option>
                  <option value="MANAGER">Manager</option>
                  {session?.isAdmin && <option value="HR_ADMIN">HR admin</option>}
                  {session?.isAdmin && <option value="ADMIN">Administrator</option>}
                </select>
              </FormField>
            )}
          </div>
        </section>
      )}

      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="button button-primary" type="submit" disabled={saving}>
          {saving ? <Spinner size={16} /> : <Check size={16} />} {isEdit ? 'Save changes' : 'Add employee'}
        </button>
      </div>
    </form>
  )
}
