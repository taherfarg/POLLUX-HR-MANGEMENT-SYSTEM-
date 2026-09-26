import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, CircleAlert, LocateFixed, LogIn, LogOut, QrCode, Wifi } from 'lucide-react'
import { ErrorState, LoadingState, Panel, Spinner } from '../components/ui.jsx'
import { useResource } from '../hooks/useResource.js'
import { emitChange } from '../lib/events.js'
import { formatDay, formatMinutes } from '../lib/format.js'
import { currentPosition } from '../lib/onsite.js'
import { defaultPage } from '../navigation.js'
import { checkIn, checkOut, fetchAttendanceToday } from '../api/endpoints.js'

const isMobileDevice = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)

/**
 * Where the office QR code leads: #/check-in/<code>. One button - check in, or
 * check out when already in - that sends the scanned code and this device's
 * position; the server decides whether that is on site.
 */
export default function CheckInPage({ session, param, navigate }) {
  const code = param ?? ''
  const today = useResource(() => fetchAttendanceToday(), [])
  const [position, setPosition] = useState(null)
  const [locating, setLocating] = useState(false)
  const [positionError, setPositionError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  const data = today.data
  const onSite = data?.onSite ?? null
  const needsLocation = Boolean(onSite?.needsLocation)

  const locate = useCallback(async () => {
    setLocating(true)
    setPositionError(null)
    try {
      setPosition(await currentPosition())
    } catch (caught) {
      setPositionError(caught.message)
    } finally {
      setLocating(false)
    }
  }, [])

  // Ask for the position as soon as the page knows it is needed: the browser's
  // permission prompt comes up front, and the phone's GPS is warm by the tap.
  useEffect(() => {
    if (needsLocation) locate()
  }, [needsLocation, locate])

  // Another code (or the same one scanned again) starts afresh.
  useEffect(() => {
    setError(null)
    setDone(null)
  }, [code])

  if (today.loading && !data) return <LoadingState label="Loading your day…" />
  if (today.error) return <ErrorState error={today.error} onRetry={today.reload} />

  const day = data.today
  const action = data.canCheckOut ? 'out' : data.canCheckIn ? 'in' : null
  const ready = Boolean(code) && Boolean(action)

  const run = async () => {
    setBusy(true)
    setError(null)
    // Where the person is now, not where they were when the page opened -
    // someone refused in the car park walks in and taps again.
    let fix = null
    if (needsLocation) {
      try {
        fix = await currentPosition()
        setPosition(fix)
        setPositionError(null)
      } catch (caught) {
        setPositionError(caught.message)
        setBusy(false)
        return
      }
    }
    const evidence = { qrCode: code, source: isMobileDevice() ? 'MOBILE' : 'WEB', ...(fix ?? {}) }
    try {
      const result = action === 'in' ? await checkIn(undefined, evidence) : await checkOut(undefined, evidence)
      setDone(
        action === 'in'
          ? `Checked in at ${result.checkInLocal}${result.lateMinutes ? ` - ${formatMinutes(result.lateMinutes)} late` : ''}.`
          : `Checked out at ${result.checkOutLocal}. Worked ${formatMinutes(result.workedMinutes)}.`,
      )
      emitChange('attendance')
      today.reload()
    } catch (caught) {
      setError(caught.message)
    } finally {
      setBusy(false)
    }
  }

  let headline = 'Not checked in yet'
  if (day?.checkIn && !day.checkOut) headline = `Checked in at ${day.checkInLocal}`
  else if (day?.checkOut) headline = `Done for today at ${day.checkOutLocal}`
  else if (day?.dayType === 'LEAVE') headline = 'On leave today'

  return (
    <div className="page check-in-page">
      <section className="clock-card" aria-label="Today">
        <header>
          <div>
            <p className="eyebrow">
              {formatDay(data.localDate)} · {data.timezone}
            </p>
            <h3>{data.localTime}</h3>
            <p>{headline}</p>
          </div>
        </header>
      </section>

      <Panel title={onSite ? `Check in or out at ${onSite.locationName}` : 'Check in or out'}>
        <ul className="onsite-checks">
          <li className={code ? 'ok' : 'bad'}>
            <QrCode size={18} />
            <span>{code ? 'Office QR code scanned' : 'Open this page by scanning the QR code at the office'}</span>
          </li>
          {needsLocation && (
            <li className={position ? 'ok' : positionError ? 'bad' : 'wait'}>
              <LocateFixed size={18} />
              <span>
                {position
                  ? `Location found (±${Math.round(position.accuracy)} m)`
                  : positionError ?? 'Finding your location… allow it if the browser asks'}
              </span>
              {positionError && (
                <button type="button" className="button button-ghost button-sm" onClick={locate} disabled={locating}>
                  {locating ? <Spinner size={14} /> : null} Try again
                </button>
              )}
            </li>
          )}
          {onSite?.needsNetwork && (
            <li className="info">
              <Wifi size={18} />
              <span>Connected to {onSite.wifiName ?? 'the office Wi-Fi'}, not mobile data</span>
            </li>
          )}
        </ul>

        {error && (
          <div className="form-error" role="alert">
            <CircleAlert size={16} />
            <span>{error}</span>
          </div>
        )}

        {done ? (
          <div className="onsite-done" role="status">
            <CheckCircle2 size={22} />
            <strong>{done}</strong>
            <button type="button" className="button button-secondary" onClick={() => navigate(defaultPage(session))}>
              Done
            </button>
          </div>
        ) : action ? (
          <button type="button" className="button button-primary button-wide button-lg" onClick={run} disabled={!ready || busy}>
            {busy ? <Spinner size={18} /> : action === 'in' ? <LogIn size={18} /> : <LogOut size={18} />}
            {action === 'in' ? 'Check in' : 'Check out'}
          </button>
        ) : (
          <p className="muted">{day?.checkOut ? 'You have checked in and out today.' : 'There is nothing to check in or out right now.'}</p>
        )}
      </Panel>
    </div>
  )
}
