/**
 * On-site check-in helpers: the link a printed QR code carries, the office
 * position HR types or pastes, and the browser's own position.
 */

/** The link a printed QR code carries: this app, opened at the check-in page with the code. */
export function checkInLink(code, origin = window.location.origin, pathname = window.location.pathname) {
  return `${origin}${pathname}#/check-in/${encodeURIComponent(code)}`
}

// No look-alikes (0/O, 1/l/I), so a code can also be read out or typed.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/** A random code for a new QR, from the browser's cryptographic source. */
export function generateQrCode(length = 12) {
  const values = new Uint32Array(length)
  crypto.getRandomValues(values)
  return Array.from(values, (value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join('')
}

const inRange = (latitude, longitude) =>
  Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180

/**
 * Reads a position from what HR pastes: "25.204849, 55.270782" as Google Maps
 * copies it, or a full Google Maps link with the coordinates in it. A short
 * maps.app.goo.gl link has none - open it and copy the coordinates instead.
 */
export function parseCoordinates(text) {
  const value = String(text ?? '').trim()
  if (!value) return null
  const patterns = [
    /^(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/, // 25.17, 55.37
    /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/, // .../@25.17,55.37,17z
    /[?&](?:q|query|ll)=(-?\d{1,2}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i, // ?q=25.17,55.37
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, // ...!3d25.17!4d55.37
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(value)
    if (!match) continue
    const latitude = Number(match[1])
    const longitude = Number(match[2])
    if (inRange(latitude, longitude)) return { latitude, longitude }
  }
  return null
}

export const formatCoordinates = ({ latitude, longitude }) => `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`

export const googleMapsLink = ({ latitude, longitude }) => `https://www.google.com/maps?q=${latitude},${longitude}`

const POSITION_ERRORS = {
  1: 'Location access is blocked. Allow it for this site in the browser settings, then try again.',
  2: 'Your location could not be found. Turn on location services and try again.',
  3: 'Finding your location took too long. Try again - near a window helps.',
}

/** The browser's current position, asking for permission the first time. */
export function currentPosition({ timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser cannot share its location.'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        }),
      (error) => reject(new Error(POSITION_ERRORS[error.code] ?? POSITION_ERRORS[2])),
      { enableHighAccuracy: true, timeout, maximumAge: 0 },
    )
  })
}

/** How a check-in or check-out was verified, in one line for HR. */
export function describeVerification(verification) {
  if (!verification) return null
  const parts = [`QR code at ${verification.locationName}`]
  if (verification.distanceMeters !== null && verification.distanceMeters !== undefined) {
    const accuracy = verification.accuracyMeters ? ` (±${verification.accuracyMeters} m)` : ''
    parts.push(`${verification.distanceMeters} m away${accuracy}`)
  }
  if (verification.network === 'OFFICE') parts.push('office network')
  return parts.join(' · ')
}
