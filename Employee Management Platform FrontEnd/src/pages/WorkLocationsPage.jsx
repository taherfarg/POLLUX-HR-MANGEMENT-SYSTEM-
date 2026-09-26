import { useEffect, useState } from 'react'
import { Download, LocateFixed, MapPin, Pencil, Plus, Printer, QrCode, RefreshCw, Wifi } from 'lucide-react'
import { Async, Chip, DataTable, EmptyState, FormError, FormField, Modal, PageHeader, Panel, Spinner, StatusPill, useSubmit } from '../components/ui.jsx'
import { useCompany } from '../hooks/useCompany.jsx'
import { useResource } from '../hooks/useResource.js'
import { checkInLink, currentPosition, formatCoordinates, generateQrCode, googleMapsLink, parseCoordinates } from '../lib/onsite.js'
import { createWorkLocation, fetchMyNetwork, fetchWorkLocations, updateWorkLocation } from '../api/endpoints.js'
import { WORK_LOCATION_KIND_LABELS } from '../api/adapters.js'
import { TIMEZONE_OPTIONS } from '../data.js'

/**
 * Where people work. A remote colleague in Cairo is a work location with a
 * Cairo timezone - never a branch or a separate company. An office can require
 * on-site check-in: its QR code, scanned on site, on the office network.
 */
export default function WorkLocationsPage({ session, onToast }) {
  const locations = useResource(() => fetchWorkLocations(session.isManagement), [session.isManagement])
  const company = useCompany()
  const [editing, setEditing] = useState(null)
  const [showingQr, setShowingQr] = useState(null)

  const saved = (message) => {
    setEditing(null)
    locations.reload()
    company.reload()
    onToast(message)
  }

  return (
    <div className="page">
      <PageHeader
        title="Work locations"
        description="The Dubai office, the field and remote locations. Each carries the timezone attendance is read in."
        actions={
          session.isManagement && (
            <button className="button button-primary" onClick={() => setEditing({})}>
              <Plus size={16} /> Add location
            </button>
          )
        }
      />
      <Panel flush>
        <Async loading={locations.loading} error={locations.error} onRetry={locations.reload} rows={4}>
          <DataTable
            columns={[
              {
                key: 'name',
                label: 'Location',
                primary: true,
                render: (row) => (
                  <div>
                    <strong>
                      {row.name} {row.qrCheckInRequired && <Chip icon={QrCode}>QR check-in</Chip>}
                    </strong>
                    <small>{[row.addressLine, row.city, row.countryName].filter(Boolean).join(', ') || '—'}</small>
                  </div>
                ),
              },
              { key: 'kind', label: 'Type', render: (row) => WORK_LOCATION_KIND_LABELS[row.kind] ?? row.kind },
              { key: 'timezone', label: 'Timezone', render: (row) => row.timezone ?? 'Company timezone' },
              { key: 'headcount', label: 'People', className: 'num', render: (row) => row.headcount ?? '—' },
              { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
              {
                key: 'actions',
                label: '',
                className: 'actions',
                render: (row) =>
                  session.isManagement ? (
                    <div className="button-row" style={{ justifyContent: 'flex-end' }}>
                      {row.qrCode && (
                        <button className="button button-ghost button-sm" onClick={() => setShowingQr(row)} aria-label={`QR code for ${row.name}`}>
                          <QrCode size={14} /> QR code
                        </button>
                      )}
                      <button className="button button-ghost button-sm" onClick={() => setEditing(row)} aria-label={`Edit ${row.name}`}>
                        <Pencil size={14} /> Edit
                      </button>
                    </div>
                  ) : null,
              },
            ]}
            rows={locations.data ?? []}
            empty={<EmptyState icon={MapPin} title="No work locations yet" />}
          />
        </Async>
      </Panel>
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.id ? `Edit ${editing.name}` : 'Add work location'} size="lg">
        {editing && <LocationForm location={editing} onCancel={() => setEditing(null)} onSaved={saved} />}
      </Modal>
      <Modal open={Boolean(showingQr)} onClose={() => setShowingQr(null)} title="Check-in QR code" eyebrow={showingQr?.name} size="sm">
        {showingQr && <QrCodeSheet location={showingQr} onClose={() => setShowingQr(null)} />}
      </Modal>
    </div>
  )
}

function LocationForm({ location, onCancel, onSaved }) {
  const isEdit = Boolean(location.id)
  const hasPosition = location.latitude !== null && location.latitude !== undefined && location.longitude !== null && location.longitude !== undefined
  const [form, setForm] = useState({
    code: location.code ?? '',
    name: location.name ?? '',
    kind: location.kind ?? 'OFFICE',
    addressLine: location.addressLine ?? '',
    city: location.city ?? '',
    countryCode: location.countryCode ?? '',
    countryName: location.countryName ?? '',
    timezone: location.timezone ?? '',
    isActive: location.isActive ?? true,
    qrCheckInRequired: location.qrCheckInRequired ?? false,
    qrCode: location.qrCode ?? '',
    position: hasPosition ? formatCoordinates(location) : '',
    geofenceRadiusMeters: String(location.geofenceRadiusMeters ?? 200),
    networks: (location.allowedNetworks ?? []).join('\n'),
    wifiName: location.wifiName ?? '',
  })
  const [locating, setLocating] = useState(false)
  const [networkNote, setNetworkNote] = useState(null)
  const [helperError, setHelperError] = useState(null)
  const set = (key, value) => setForm((state) => ({ ...state, [key]: value }))
  const coordinates = parseCoordinates(form.position)

  const useMyPosition = async () => {
    setLocating(true)
    setHelperError(null)
    try {
      set('position', formatCoordinates(await currentPosition()))
    } catch (caught) {
      setHelperError(caught.message)
    } finally {
      setLocating(false)
    }
  }

  // Pressed on the office Wi-Fi, this registers the office's own address.
  const addMyNetwork = async () => {
    setHelperError(null)
    try {
      const seen = await fetchMyNetwork()
      if (!seen.entry) throw new Error('The address of this connection could not be read.')
      if (seen.isPrivate) {
        setNetworkNote(`The server sees ${seen.ip}, a private address - the proxy setting needs checking before networks can be used.`)
        return
      }
      const current = form.networks.split(/[\s,]+/).filter(Boolean)
      if (!current.includes(seen.entry)) set('networks', [...current, seen.entry].join('\n'))
      setNetworkNote(`Added ${seen.entry} - the address this connection reaches Pollux HR from.`)
    } catch (caught) {
      setHelperError(caught.message)
    }
  }

  const { submit, saving, error } = useSubmit(async () => {
    if (form.position.trim() && !coordinates) {
      throw new Error('The office position is not a pair of coordinates. Paste them as "25.204849, 55.270782".')
    }
    const payload = {
      name: form.name,
      kind: form.kind,
      addressLine: form.addressLine || undefined,
      city: form.city || undefined,
      countryCode: form.countryCode ? form.countryCode.toUpperCase() : undefined,
      countryName: form.countryName || undefined,
      timezone: form.timezone || (isEdit ? null : undefined),
      isActive: form.isActive,
      qrCheckInRequired: form.qrCheckInRequired,
      qrCode: form.qrCode.trim() || null,
      latitude: coordinates?.latitude ?? null,
      longitude: coordinates?.longitude ?? null,
      geofenceRadiusMeters: Number(form.geofenceRadiusMeters) || 200,
      allowedNetworks: form.networks.split(/[\s,]+/).filter(Boolean),
      wifiName: form.wifiName.trim() || null,
    }
    if (isEdit) await updateWorkLocation(location.id, payload)
    else await createWorkLocation({ ...payload, code: form.code })
    onSaved(isEdit ? 'Work location updated.' : 'Work location added.')
  })

  return (
    <form className="simple-form" onSubmit={submit} noValidate>
      <div className="two-col">
        {!isEdit && (
          <FormField label="Code" error={error?.fieldError?.('code')} hint="e.g. REMOTE-CAI">
            <input value={form.code} onChange={(e) => set('code', e.target.value)} required />
          </FormField>
        )}
        <FormField label="Name" error={error?.fieldError?.('name')}>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Remote - Cairo" required />
        </FormField>
        <FormField label="Type">
          <select value={form.kind} onChange={(e) => set('kind', e.target.value)}>
            {Object.entries(WORK_LOCATION_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Timezone" error={error?.fieldError?.('timezone')} hint="Attendance for people here is read in this zone.">
          <input list="location-timezones" value={form.timezone} onChange={(e) => set('timezone', e.target.value)} placeholder="Asia/Dubai" />
          <datalist id="location-timezones">
            {TIMEZONE_OPTIONS.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </FormField>
        <FormField label="City">
          <input value={form.city} onChange={(e) => set('city', e.target.value)} />
        </FormField>
        <FormField label="Country">
          <input value={form.countryName} onChange={(e) => set('countryName', e.target.value)} />
        </FormField>
        <FormField label="Country code" error={error?.fieldError?.('countryCode')}>
          <input value={form.countryCode} maxLength={2} onChange={(e) => set('countryCode', e.target.value)} placeholder="AE" />
        </FormField>
        <FormField label="Address">
          <input value={form.addressLine} onChange={(e) => set('addressLine', e.target.value)} />
        </FormField>
      </div>
      <label className="check">
        <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} /> Active
      </label>

      <section className="form-section">
        <header>
          <h3>On-site check-in</h3>
          <p>
            A web page cannot read the Wi-Fi name, so the office network is recognised by the address its internet connection has.
          </p>
        </header>
        <label className="check">
          <input
            type="checkbox"
            checked={form.qrCheckInRequired}
            onChange={(e) => set('qrCheckInRequired', e.target.checked)}
          />{' '}
          People here check in and out by scanning this location&apos;s QR code
        </label>
        {error?.fieldError?.('qrCheckInRequired') && <p className="form-error">{error.fieldError('qrCheckInRequired')}</p>}

        <div className="two-col">
          <FormField label="QR code text" error={error?.fieldError?.('qrCode')} hint="What the printed code carries. Change it to retire printed copies.">
            <input value={form.qrCode} onChange={(e) => set('qrCode', e.target.value)} placeholder="front-door-2026" autoComplete="off" />
          </FormField>
          <FormField label="Allowed distance (m)" error={error?.fieldError?.('geofenceRadiusMeters')} hint="Phones indoors are often 20-100 m off.">
            <input type="number" min="25" max="5000" step="25" value={form.geofenceRadiusMeters} onChange={(e) => set('geofenceRadiusMeters', e.target.value)} />
          </FormField>
          <FormField
            label="Office position"
            error={error?.fieldError?.('latitude') ?? error?.fieldError?.('longitude')}
            hint={coordinates ? undefined : 'Latitude, longitude - as Google Maps copies them when you right-click the office.'}
          >
            <input value={form.position} onChange={(e) => set('position', e.target.value)} placeholder="25.204849, 55.270782" />
          </FormField>
          <FormField label="Office Wi-Fi name" hint="Shown to people who are not on the office network.">
            <input value={form.wifiName} onChange={(e) => set('wifiName', e.target.value)} placeholder="Office-5G or Office-2G" />
          </FormField>
        </div>
        <div className="button-row">
          <button type="button" className="button button-ghost button-sm" onClick={() => set('qrCode', generateQrCode())}>
            <RefreshCw size={14} /> Generate a code
          </button>
          <button type="button" className="button button-ghost button-sm" onClick={useMyPosition} disabled={locating}>
            {locating ? <Spinner size={14} /> : <LocateFixed size={14} />} Use my current position
          </button>
          {coordinates && (
            <a className="button button-ghost button-sm" href={googleMapsLink(coordinates)} target="_blank" rel="noreferrer">
              <MapPin size={14} /> Check on Google Maps
            </a>
          )}
        </div>

        <FormField
          label="Office network"
          error={error?.fieldError?.('allowedNetworks')}
          hint="The public address of the office internet connection - one per line. Press the button below while on the office Wi-Fi."
        >
          <textarea rows="2" value={form.networks} onChange={(e) => set('networks', e.target.value)} placeholder="203.0.113.7" />
        </FormField>
        <div className="button-row">
          <button type="button" className="button button-ghost button-sm" onClick={addMyNetwork}>
            <Wifi size={14} /> Add the network I&apos;m on now
          </button>
        </div>
        {networkNote && <p className="network-note">{networkNote}</p>}
        {helperError && <p className="form-error">{helperError}</p>}
      </section>

      <FormError error={error} />
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={saving}>
          {saving && <Spinner size={15} />} Save
        </button>
      </div>
    </form>
  )
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

/** The printable QR code: it opens the check-in page with this location's code. */
function QrCodeSheet({ location, onClose }) {
  const link = checkInLink(location.qrCode)
  const [svg, setSvg] = useState('')
  const [png, setPng] = useState('')

  useEffect(() => {
    let cancelled = false
    // Loaded on demand: only HR ever draws a QR code.
    import('qrcode')
      .then(({ default: QRCode }) =>
        Promise.all([
          QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
          QRCode.toDataURL(link, { width: 1024, margin: 2, errorCorrectionLevel: 'M' }),
        ]),
      )
      .then(([vector, image]) => {
        if (cancelled) return
        setSvg(vector)
        setPng(image)
      })
    return () => {
      cancelled = true
    }
  }, [link])

  const print = () => {
    const sheet = window.open('', '_blank', 'width=640,height=820')
    if (!sheet) return
    sheet.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(location.name)} - check-in QR code</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;padding:48px 24px;color:#0f172a}
h1{font-size:28px;margin:0 0 6px}p{margin:0 0 20px;color:#334155}svg{width:380px;height:380px}small{display:block;margin-top:16px;color:#64748b;word-break:break-all}</style>
</head><body><h1>${escapeHtml(location.name)}</h1><p>Scan to check in or out &middot; Pollux HR</p>${svg}<small>${escapeHtml(link)}</small></body></html>`)
    sheet.document.close()
    sheet.focus()
    sheet.print()
  }

  return (
    <div className="qr-sheet">
      {/* The SVG is generated here from the location's own link. */}
      {svg ? (
        <div className="qr-image" dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label={`QR code for ${location.name}`} />
      ) : (
        <Spinner size={24} />
      )}
      <p>Scanning it with a phone camera opens the check-in page. The phone also has to be at the office - and on its network, if one is set.</p>
      <code>{link}</code>
      <div className="form-actions">
        <button type="button" className="button button-ghost" onClick={onClose}>
          Done
        </button>
        {png && (
          <a className="button button-secondary" href={png} download={`${location.code || 'location'}-check-in-qr.png`}>
            <Download size={15} /> Download
          </a>
        )}
        <button type="button" className="button button-primary" onClick={print} disabled={!svg}>
          <Printer size={15} /> Print
        </button>
      </div>
    </div>
  )
}
