import { describe, expect, it } from 'vitest'
import { checkInLink, describeVerification, formatCoordinates, generateQrCode, googleMapsLink, parseCoordinates } from '../src/lib/onsite.js'

describe('on-site check-in helpers', () => {
  it('builds the link a printed QR code carries', () => {
    expect(checkInLink('front-door-2026', 'https://pollux-hr-web.onrender.com', '/')).toBe('https://pollux-hr-web.onrender.com/#/check-in/front-door-2026')
    expect(checkInLink('a b', 'https://x.test', '/')).toBe('https://x.test/#/check-in/a%20b')
  })

  it('generates unambiguous random codes', () => {
    const code = generateQrCode()
    expect(code).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/)
    expect(generateQrCode()).not.toBe(code)
  })

  it('reads the office position however HR pastes it', () => {
    const office = { latitude: 25.204849340672496, longitude: 55.270782470703125 }
    expect(parseCoordinates('25.204849340672496, 55.270782470703125')).toEqual(office)
    expect(parseCoordinates('  25.204849340672496,55.270782470703125 ')).toEqual(office)
    expect(parseCoordinates('https://www.google.com/maps/place/Pollux/@25.2048493,55.2707825,17z/data=!3d25.2048493!4d55.2707825')).toEqual({
      latitude: 25.2048493,
      longitude: 55.2707825,
    })
    expect(parseCoordinates('https://www.google.com/maps?q=25.2048,55.2708')).toEqual({ latitude: 25.2048, longitude: 55.2708 })
    // A short link carries no coordinates.
    expect(parseCoordinates('https://maps.app.goo.gl/AbCdEfGhIjKlMnOp9')).toBeNull()
    expect(parseCoordinates('95, 200')).toBeNull()
    expect(parseCoordinates('')).toBeNull()
  })

  it('formats positions for the form and for Google Maps', () => {
    const office = { latitude: 25.204849340672496, longitude: 55.270782470703125 }
    expect(formatCoordinates(office)).toBe('25.204849, 55.270782')
    expect(googleMapsLink(office)).toBe('https://www.google.com/maps?q=25.204849340672496,55.270782470703125')
  })

  it('describes how a check-in was verified', () => {
    expect(describeVerification({ locationName: 'Dubai Office', distanceMeters: 42, accuracyMeters: 12, network: 'OFFICE' })).toBe(
      'QR code at Dubai Office · 42 m away (±12 m) · office network',
    )
    expect(describeVerification({ locationName: 'Dubai Office', distanceMeters: null, network: 'OFFICE' })).toBe('QR code at Dubai Office · office network')
    expect(describeVerification(null)).toBeNull()
  })
})
