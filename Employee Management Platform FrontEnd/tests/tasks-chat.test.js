import { describe, expect, it } from 'vitest'
import { changedMessages, dayLabel, latestChange, mergeMessages, previewLine, threadRows } from '../src/lib/chat.js'
import { describeDue, taskViewsFor } from '../src/lib/tasks.js'

const NOW = new Date(2026, 9, 20, 10, 0) // Tue 20 Oct 2026, 10:00 local

describe('task due dates', () => {
  it('reads open work by how close it is', () => {
    expect(describeDue('2026-10-20', 'TODO', NOW)).toMatchObject({ label: 'Today', tone: 'warning' })
    expect(describeDue('2026-10-21', 'IN_PROGRESS', NOW)).toMatchObject({ label: 'Tomorrow' })
    expect(describeDue('2026-10-19', 'TODO', NOW)).toMatchObject({ label: '1 day late', tone: 'danger' })
    expect(describeDue('2026-10-15', 'TODO', NOW)).toMatchObject({ label: '5 days late', tone: 'danger' })
    expect(describeDue('2026-10-23', 'TODO', NOW).label).toMatch(/^Fri,? 23 Oct$/)
  })

  it('never calls finished work late', () => {
    expect(describeDue('2026-10-15', 'DONE', NOW)).toMatchObject({ tone: 'muted', label: expect.stringMatching(/^Thu,? 15 Oct$/) })
    expect(describeDue(null, 'TODO', NOW)).toMatchObject({ label: 'No due date' })
  })

  it('offers each role the task lists it can see', () => {
    const employee = { id: 'e1' }
    const views = (session) => taskViewsFor(session).map((view) => view.value)
    expect(views({ employee, isManager: false, isManagement: false })).toEqual(['mine', 'created'])
    expect(views({ employee, isManager: true, isManagement: false })).toEqual(['mine', 'created', 'team'])
    expect(views({ employee, isManager: false, isManagement: true })).toEqual(['mine', 'created', 'team', 'all'])
    expect(views({ employee: null, isManager: false, isManagement: true })).toEqual(['created', 'all'])
  })
})

const message = (id, minute, extra = {}) => ({
  id,
  createdAt: new Date(2026, 9, 20, 9, minute).toISOString(),
  updatedAt: new Date(2026, 9, 20, 9, minute).toISOString(),
  sender: { id: 'u1', fullName: 'Sara Haddad' },
  isSystem: false,
  isMine: false,
  body: `message ${id}`,
  ...extra,
})

describe('chat threads', () => {
  it('merges polled messages by id, in order, with a newer copy winning', () => {
    const current = [message('a', 1), message('b', 2)]
    const deleted = { ...message('b', 2), isDeleted: true, body: null, updatedAt: new Date(2026, 9, 20, 9, 5).toISOString() }
    const merged = mergeMessages(current, [message('c', 3), deleted, message('a', 1)])
    expect(merged.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(merged[1].isDeleted).toBe(true)
    expect(latestChange(merged)).toBe(deleted.updatedAt)
    expect(changedMessages(current, [message('a', 1), deleted]).map((entry) => entry.id)).toEqual(['b'])
  })

  it('groups a run of messages from one person, and starts a new day with a separator', () => {
    const yesterday = { ...message('y', 0), createdAt: new Date(2026, 9, 19, 17, 0).toISOString() }
    const rows = threadRows([yesterday, message('a', 1), message('b', 2), message('c', 3, { sender: { id: 'u2', fullName: 'Ahmed Nabil' } }), message('d', 30, { sender: { id: 'u2', fullName: 'Ahmed Nabil' } })], NOW)
    expect(rows.map((row) => (row.type === 'day' ? row.label : `${row.key}${row.continued ? '+' : ''}`))).toEqual([
      'Yesterday',
      'y',
      'Today',
      'a',
      'b+',
      'c',
      'd', // half an hour later starts a new run
    ])
    expect(dayLabel(new Date(2026, 9, 14, 9, 0), NOW)).toBe('Wednesday 14 Oct')
  })

  it('previews the last line the way chat lists do', () => {
    const direct = { kind: 'DIRECT', lastMessage: { body: 'See you at 9', isMine: true, sender: { fullName: 'Ahmed Nabil' } } }
    expect(previewLine(direct)).toBe('You: See you at 9')
    const group = { kind: 'GROUP', lastMessage: { body: 'Done', isMine: false, sender: { fullName: 'Layla Mansour' } } }
    expect(previewLine(group)).toBe('Layla: Done')
    expect(previewLine({ ...group, lastMessage: { ...group.lastMessage, isDeleted: true } })).toBe('Message deleted')
    expect(previewLine({ kind: 'DIRECT', lastMessage: null })).toBe('Say hello')
  })
})
