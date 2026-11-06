/** Helpers for the assistant page, kept apart so they can be unit tested. */

/** What the "Daily brief" buttons ask. */
export const ASSISTANT_BRIEF =
  'Give me today’s brief: attendance right now (who is late or not in yet), who is on leave today, what is waiting for my decision, overdue tasks, and anything else that needs my attention.'

/** The page behind each source an answer names, so a reader can check it there. */
const SOURCE_PAGES = {
  attendance_today: 'attendance',
  attendance_summary: 'reports',
  late_arrivals: 'reports',
  absences: 'reports',
  attendance_by_group: 'reports',
  attendance_by_day: 'reports',
  overtime: 'overtime',
  leave: 'requests',
  leave_balances: 'leave-balances',
  employee_list: 'employees',
  employee_profile: 'employees',
  my_team: 'my-team',
  pending_approvals: 'requests',
  tasks: 'tasks',
  propose_task: 'tasks',
  propose_request_decision: 'requests',
  holidays: 'holidays',
  attention_items: 'dashboard',
}

/** Where a source opens for this person, or null when they have no such page. */
export function sourcePage(tool, allowed) {
  const page = SOURCE_PAGES[tool]
  if (!page) return null
  if (allowed.has(page)) return page
  // A manager has the team's leave balances and the dashboard on other pages.
  if (page === 'leave-balances' || page === 'employees') return allowed.has('my-team') ? 'my-team' : null
  if (page === 'dashboard') return allowed.has('home') ? 'home' : null
  return null
}

/** Answers saved before sources carried their tool name are shown as plain labels. */
export function normaliseSources(sources) {
  return (Array.isArray(sources) ? sources : []).map((source) => (typeof source === 'string' ? { tool: null, label: source } : source))
}

/** Starting points on an empty conversation - some in Arabic, as people here ask. */
export function assistantSuggestions(scope) {
  const team = scope === 'team'
  return [
    'ملخص الحضور النهارده',
    'فيه حاجة محتاجة متابعة مني؟',
    team ? 'مين من فريقي في إجازة الأسبوع ده؟' : 'مين في إجازة الأسبوع ده؟',
    team ? 'Who in my team was late last week?' : 'Which department was late most last month?',
    'What is waiting for my approval?',
    team ? 'How was my team’s attendance each day this week?' : 'Who has fewer than 5 annual leave days left?',
  ]
}

const KEY = (userId) => `pollux.assistant.${userId}`
const MAX_KEPT = 40

/**
 * The conversation survives moving between pages and a reload, for this tab
 * only - sessionStorage, so it is gone when the tab closes and never shared.
 */
export function loadConversation(userId, storage = globalThis.sessionStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(KEY(userId)) ?? '[]')
    return Array.isArray(saved) ? saved.filter((message) => message && typeof message.text === 'string' && (message.role === 'user' || message.role === 'assistant')) : []
  } catch {
    return []
  }
}

/** On sign-out: nothing anyone asked stays behind in the tab. */
export function forgetConversations(storage = globalThis.sessionStorage) {
  try {
    const keys = Array.from({ length: storage?.length ?? 0 }, (_, index) => storage.key(index))
    for (const key of keys) if (key?.startsWith('pollux.assistant.')) storage.removeItem(key)
  } catch {
    // Nothing to clear.
  }
}

export function saveConversation(userId, messages, storage = globalThis.sessionStorage) {
  try {
    if (messages.length) storage?.setItem(KEY(userId), JSON.stringify(messages.slice(-MAX_KEPT)))
    else storage?.removeItem(KEY(userId))
  } catch {
    // Private mode or full storage: the conversation simply is not kept.
  }
}
