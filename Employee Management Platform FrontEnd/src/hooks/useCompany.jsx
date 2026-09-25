import { createContext, useContext, useMemo } from 'react'
import { useResource } from './useResource.js'
import {
  fetchCompanySettings,
  fetchDepartments,
  fetchHolidayCalendars,
  fetchWorkLocations,
  fetchWorkSchedules,
} from '../api/endpoints.js'

const CompanyContext = createContext({
  company: null,
  departments: [],
  locations: [],
  schedules: [],
  calendars: [],
  currency: 'AED',
  reload: () => {},
})

/**
 * The company and its reference data - departments, work locations,
 * schedules, holiday calendars. Needed by filters, forms and profiles on
 * almost every screen and rarely changed, so loaded once at the shell.
 *
 * Everyone receives the public company view (name, logo, currency, timezone,
 * working week); HR and administrators receive the full policy.
 */
export function CompanyProvider({ children }) {
  const company = useResource(() => fetchCompanySettings(), [])
  const departments = useResource(() => fetchDepartments(), [])
  const locations = useResource(() => fetchWorkLocations(), [])
  const schedules = useResource(() => fetchWorkSchedules(), [])
  const calendars = useResource(() => fetchHolidayCalendars(), [])

  const value = useMemo(
    () => ({
      company: company.data,
      departments: departments.data ?? [],
      locations: locations.data ?? [],
      schedules: schedules.data ?? [],
      calendars: calendars.data ?? [],
      currency: company.data?.company?.currency ?? 'AED',
      companyName: company.data?.company?.legalName ?? company.data?.company?.displayName ?? 'Pollux HR',
      reload: () => {
        company.reload()
        departments.reload()
        locations.reload()
        schedules.reload()
        calendars.reload()
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [company.data, departments.data, locations.data, schedules.data, calendars.data],
  )

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
}

export function useCompany() {
  return useContext(CompanyContext)
}
