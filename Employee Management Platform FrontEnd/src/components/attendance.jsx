import { useState } from 'react'
import { LogIn, LogOut, QrCode } from 'lucide-react'
import { ErrorState, LoadingState, Spinner, StatusPill } from './ui.jsx'
import { useResource } from '../hooks/useResource.js'
import { emitChange, useChangeListener } from '../lib/events.js'
import { formatDay, formatMinutes } from '../lib/format.js'
import { checkIn, checkOut, fetchAttendanceToday } from '../api/endpoints.js'

/** Attendance statuses as people say them. */
export const ATTENDANCE_LABELS = {
  PRESENT: 'Present',
  LATE: 'Late',
  ABSENT: 'Absent',
  ON_LEAVE: 'On leave',
  HOLIDAY: 'Holiday',
  WEEKEND: 'Rest day',
  PARTIAL: 'Partial day',
  MISSING_CHECKOUT: 'Missing check-out',
  SCHEDULED: 'Scheduled',
  NOT_CHECKED_IN: 'Not checked in',
  NOT_EMPLOYED: 'Not employed',
  NOT_TRACKED: 'Not tracked',
}

export function AttendanceStatus({ day }) {
  if (!day) return null
  const status = day.isOpen ? 'OPEN' : day.status
  const label = day.isOpen ? (day.lateMinutes > 0 ? 'Checked in · late' : 'Checked in') : ATTENDANCE_LABELS[day.status] ?? day.status
  return <StatusPill status={status} label={label} />
}

/** Check in and out, with the server clock as the only clock that counts. */
function useClockActions(onToast) {
  const [busy, setBusy] = useState(false)
  const run = async (action) => {
    setBusy(true)
    try {
      const day = action === 'in' ? await checkIn() : await checkOut()
      onToast?.(
        action === 'in'
          ? `Checked in at ${day.checkInLocal} (${day.timezone}).${day.lateMinutes ? ` ${day.lateMinutes} minutes late.` : ''}`
          : `Checked out at ${day.checkOutLocal}. Worked ${formatMinutes(day.workedMinutes)}.`,
      )
      emitChange('attendance')
    } catch (error) {
      onToast?.(error.message, 'error')
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

/** The compact check-in control in the top bar. */
export function ClockButton({ onToast }) {
  const today = useResource(() => fetchAttendanceToday(), [])
  useChangeListener('attendance', today.reload)
  const { busy, run } = useClockActions(onToast)

  const data = today.data
  if (!data) return null
  const status = data.today?.status
  // Hidden for people who never check in; shown before tracking starts, when
  // check-ins are already recorded.
  if (status === 'NOT_TRACKED' && !data.trackingStartsOn) return null
  // Where the office QR code is required, the home card says how instead.
  if (data.onSite?.required) return null

  if (data.canCheckOut) {
    return (
      <button className="clock-button in" onClick={() => run('out')} disabled={busy} title="Check out">
        {busy ? <Spinner size={15} /> : <LogOut size={15} />}
        <span className="label">Check out</span>
      </button>
    )
  }
  if (data.canCheckIn) {
    return (
      <button className="clock-button out" onClick={() => run('in')} disabled={busy} title="Check in">
        {busy ? <Spinner size={15} /> : <LogIn size={15} />}
        <span className="label">Check in</span>
      </button>
    )
  }
  return null
}

/** The large check-in card on Home and My attendance. */
export function CheckInCard({ onToast }) {
  const today = useResource(() => fetchAttendanceToday(), [])
  useChangeListener('attendance', today.reload)
  const { busy, run } = useClockActions(onToast)

  if (today.loading) return <LoadingState label="Loading today…" />
  if (today.error) return <ErrorState error={today.error} onRetry={today.reload} compact />

  const data = today.data
  const day = data.today
  const worked = day?.isOpen ? day.elapsedMinutes : day?.workedMinutes

  // What the person did comes first; the kind of day is added to it, so work
  // on a rest day or a holiday reads "Checked in at 12:02 · Rest day".
  const dayLabel = day?.dayType === 'WEEKEND' ? 'Rest day' : day?.dayType === 'HOLIDAY' ? (day.holidayName ?? 'Public holiday') : null
  const withDay = (text) => (dayLabel ? `${text} · ${dayLabel}` : text)
  let headline = 'Not checked in yet'
  if (day?.status === 'NOT_TRACKED') {
    headline = data.trackingStartsOn ? `Attendance tracking starts ${formatDay(data.trackingStartsOn)}` : 'Attendance is not tracked for you'
  }
  else if (day?.checkIn && !day.checkOut) headline = withDay(`Checked in at ${day.checkInLocal}`)
  else if (day?.checkOut) headline = withDay(`Done for today at ${day.checkOutLocal}`)
  else if (dayLabel) headline = dayLabel
  else if (day?.dayType === 'LEAVE') headline = `On leave${day.leave ? ` · ${day.leave.leaveTypeName}` : ''}`

  return (
    <section className="clock-card" aria-label="Today's attendance">
      <header>
        <div>
          <p className="eyebrow">
            {formatDay(data.localDate)} · {data.timezone}
          </p>
          <h3>{data.localTime}</h3>
          <p>{headline}</p>
        </div>
        {day && <AttendanceStatus day={day} />}
      </header>
      <div className="clock-facts">
        <div>
          <span>Schedule</span>
          <strong>{day?.scheduledStartLocal ? `${day.scheduledStartLocal}–${day.scheduledEndLocal}` : '—'}</strong>
        </div>
        <div>
          <span>Worked</span>
          <strong>{worked ? formatMinutes(worked) : '—'}</strong>
        </div>
        <div>
          <span>Late</span>
          <strong>{day?.lateMinutes ? formatMinutes(day.lateMinutes) : '—'}</strong>
        </div>
      </div>
      {data.openFromEarlierDay && (
        <p>
          Your check-in from {formatDay(data.openFromEarlierDay.date)} ({data.openFromEarlierDay.checkInLocal}) was never closed.
          {data.canCheckOut ? ' Checking out closes it.' : ' Ask HR to correct it.'}
        </p>
      )}
      <div className="button-row">
        {data.onSite?.required ? (
          // The office decides where check-in happens: the QR code on its wall
          // opens the check-in page, with this device's position.
          (data.canCheckIn || data.canCheckOut) && (
            <p className="onsite-hint">
              <QrCode size={16} />
              <span>
                Scan the QR code at {data.onSite.locationName} to check {data.canCheckOut ? 'out' : 'in'}
                {data.onSite.needsNetwork ? `, connected to ${data.onSite.wifiName ?? 'the office Wi-Fi'}` : ''}.
              </span>
            </p>
          )
        ) : (
          <>
            {data.canCheckIn && (
              <button className="button button-primary" onClick={() => run('in')} disabled={busy}>
                {busy ? <Spinner size={16} /> : <LogIn size={16} />} Check in
              </button>
            )}
            {data.canCheckOut && (
              <button className="button button-primary" onClick={() => run('out')} disabled={busy}>
                {busy ? <Spinner size={16} /> : <LogOut size={16} />} Check out
              </button>
            )}
          </>
        )}
        <span className="small" style={{ color: '#93a4c2' }}>
          {data.schedule?.name}
        </span>
      </div>
    </section>
  )
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** A month of evaluated days as a calendar (Monday first). */
export function MonthCalendar({ days, todayKey, onSelect }) {
  if (!days?.length) return null
  const first = days[0]
  // dayOfWeek: 0 = Sunday. Monday-first offset.
  const offset = (first.dayOfWeek + 6) % 7
  return (
    <div className="month-calendar" role="grid" aria-label="Attendance calendar">
      {WEEKDAYS.map((name) => (
        <div className="dow" key={name} role="columnheader">
          {name}
        </div>
      ))}
      {Array.from({ length: offset }).map((_, index) => (
        <div className="cal-day empty" key={`empty-${index}`} />
      ))}
      {days.map((day) => {
        const classes = ['cal-day']
        if (day.date === todayKey) classes.push('today')
        if (day.dayType === 'WEEKEND') classes.push('weekend')
        if (day.dayType === 'HOLIDAY') classes.push('holiday')
        const Tag = onSelect ? 'button' : 'div'
        return (
          <Tag key={day.date} className={classes.join(' ')} onClick={onSelect ? () => onSelect(day) : undefined} type={onSelect ? 'button' : undefined}>
            <span className="d">{Number(day.date.slice(8))}</span>
            {day.status !== 'SCHEDULED' && day.status !== 'NOT_EMPLOYED' && <AttendanceStatus day={day} />}
            {day.checkInLocal && (
              <span className="t">
                {day.checkInLocal}
                {day.checkOutLocal ? `–${day.checkOutLocal}` : ''}
              </span>
            )}
            {day.holidayName && <span className="t">{day.holidayName}</span>}
          </Tag>
        )
      })}
    </div>
  )
}
