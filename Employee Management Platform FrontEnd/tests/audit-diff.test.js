import { describe, expect, it } from 'vitest'
import { diffRows } from '../src/pages/AuditLogsPage.jsx'

describe('audit entry diff', () => {
  it('lists only the values that changed, by path', () => {
    const before = { attendance: { lateGraceMinutes: 15, earlyLeaveGraceMinutes: 10 } }
    const after = { attendance: { lateGraceMinutes: 20, earlyLeaveGraceMinutes: 10 } }
    expect(diffRows(before, after)).toEqual([{ path: 'attendance.lateGraceMinutes', before: '15', after: '20' }])
  })

  it('shows added and removed values, booleans and lists readably', () => {
    const rows = diffRows({ status: 'REVIEWED', flags: [1, 2] }, { status: 'APPROVED', paid: true, flags: [1, 2, 3] })
    expect(rows).toEqual([
      { path: 'flags', before: '1, 2', after: '1, 2, 3' },
      { path: 'paid', before: '—', after: 'Yes' },
      { path: 'status', before: 'REVIEWED', after: 'APPROVED' },
    ])
  })

  it('handles an entry that recorded no values', () => {
    expect(diffRows(null, null)).toEqual([])
    expect(diffRows(undefined, { totalNet: '5883.33' })).toEqual([{ path: 'totalNet', before: '—', after: '5883.33' }])
  })
})
