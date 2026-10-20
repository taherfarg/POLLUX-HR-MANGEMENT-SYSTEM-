import { avatarColor, initialsOf } from '../api/adapters.js'
import { formatDate, toDateKey } from './format.js'

/** Pure helpers behind the chat screen, kept here so they can be unit tested. */

/** Someone in a chat as the shared Avatar expects them. */
export function chatPerson(person) {
  if (!person) return null
  const parts = String(person.fullName ?? '').trim().split(/\s+/)
  return {
    ...person,
    initials: initialsOf(parts[0] || '', parts.length > 1 ? parts[parts.length - 1] : ''),
    color: avatarColor(person.id),
  }
}

const byTime = (a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt < b.createdAt ? -1 : 1)

/**
 * Folds fetched messages into what is on screen. Polling re-sends a few
 * seconds of overlap and deletions arrive as changed copies, so a message is
 * keyed by id and the newer copy wins.
 */
export function mergeMessages(current, incoming) {
  if (!incoming?.length) return current
  const byId = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) {
    const existing = byId.get(message.id)
    if (!existing || existing.updatedAt <= message.updatedAt) byId.set(message.id, message)
  }
  return [...byId.values()].sort(byTime)
}

/** The fetched messages that are new, or changed since they were last seen. */
export function changedMessages(current, incoming) {
  const seen = new Map(current.map((message) => [message.id, message.updatedAt]))
  return incoming.filter((message) => seen.get(message.id) !== message.updatedAt)
}

/** The newest change among the messages, for the next poll's `since`. */
export function latestChange(messages) {
  let latest = null
  for (const message of messages) if (!latest || message.updatedAt > latest) latest = message.updatedAt
  return latest
}

/** "Today", "Yesterday", or the date, for the separators in a thread. */
export function dayLabel(value, now = new Date()) {
  const key = toDateKey(new Date(value))
  if (key === toDateKey(now)) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (key === toDateKey(yesterday)) return 'Yesterday'
  const sameYear = new Date(value).getFullYear() === now.getFullYear()
  return formatDate(value, { weekday: 'long', year: sameYear ? undefined : 'numeric' })
}

const RUN_GAP_MS = 5 * 60 * 1000

/**
 * The thread as rows: a day separator wherever the date changes, and each
 * message marked `continued` when it follows the same sender within a few
 * minutes - those share one name and one avatar, the way chat apps group them.
 */
export function threadRows(messages, now = new Date()) {
  const rows = []
  let lastDay = null
  let previous = null
  for (const message of messages) {
    const day = toDateKey(new Date(message.createdAt))
    if (day !== lastDay) {
      rows.push({ type: 'day', key: `day-${day}`, label: dayLabel(message.createdAt, now) })
      lastDay = day
      previous = null
    }
    const continued =
      Boolean(previous) &&
      !message.isSystem &&
      !previous.isSystem &&
      previous.sender?.id === message.sender?.id &&
      new Date(message.createdAt) - new Date(previous.createdAt) < RUN_GAP_MS
    rows.push({ type: 'message', key: message.id, message, continued })
    previous = message
  }
  return rows
}

/** One line for the conversation list: "You: see you at 9", "Sara: ok". */
export function previewLine(conversation) {
  const last = conversation.lastMessage
  if (!last) return conversation.kind === 'GROUP' ? 'No messages yet' : 'Say hello'
  if (last.isDeleted) return 'Message deleted'
  if (last.isSystem) return last.body
  const who = last.isMine ? 'You' : conversation.kind === 'GROUP' ? last.sender?.fullName?.split(' ')[0] : null
  return who ? `${who}: ${last.body}` : last.body
}

/** Short time for the list: the time today, the weekday this week, else the date. */
export function listTime(value, now = new Date()) {
  if (!value) return ''
  const date = new Date(value)
  if (toDateKey(date) === toDateKey(now)) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const days = (now - date) / (24 * 60 * 60 * 1000)
  if (days < 6) return formatDate(date, { weekday: 'short', day: undefined, month: undefined, year: undefined })
  return formatDate(date, { year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}
