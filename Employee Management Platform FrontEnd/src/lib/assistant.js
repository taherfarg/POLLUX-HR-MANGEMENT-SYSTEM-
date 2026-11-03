/** Helpers for the assistant page, kept apart so they can be unit tested. */

/** What the "Daily brief" buttons ask. */
export const ASSISTANT_BRIEF =
  'Give me today’s brief: attendance right now (who is late or not in yet), who is on leave today, what is waiting for my decision, and overdue tasks.'

/** Starting points on an empty conversation - some in Arabic, as people here ask. */
export function assistantSuggestions(scope) {
  const team = scope === 'team'
  return [
    'ملخص الحضور النهارده',
    team ? 'مين من فريقي في إجازة الأسبوع ده؟' : 'مين في إجازة الأسبوع ده؟',
    team ? 'Who in my team was late last week?' : 'Who was late most often last month?',
    'What is waiting for my approval?',
    team ? 'Which of my team’s tasks are overdue?' : 'Who has fewer than 5 annual leave days left?',
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
