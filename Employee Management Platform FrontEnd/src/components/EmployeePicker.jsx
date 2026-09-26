import { FormField } from './ui.jsx'
import { useResource } from '../hooks/useResource.js'
import { fetchEmployees } from '../api/endpoints.js'

/** Choose one employee, for HR forms that act on someone's behalf. */
export function EmployeePicker({ value, onChange, error }) {
  const people = useResource(() => fetchEmployees({ pageSize: 100, sortBy: 'name' }), [])
  return (
    <FormField label="Employee" error={error}>
      <select value={value} onChange={(e) => onChange(e.target.value)} required>
        <option value="">Choose an employee</option>
        {(people.data?.items ?? []).map((person) => (
          <option key={person.id} value={person.id}>
            {person.fullName} ({person.employeeNumber})
          </option>
        ))}
      </select>
    </FormField>
  )
}
