import { describe, expect, it } from 'vitest'
import { assistantSuggestions, forgetConversations, loadConversation, saveConversation } from '../src/lib/assistant.js'
import { parseInline, parseMarkdown } from '../src/lib/markdown.js'

/** A Storage stand-in with the standard key()/length API. */
function memoryStorage() {
  const map = new Map()
  return {
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

describe('assistant answers as Markdown', () => {
  it('reads paragraphs, headings, lists and tables', () => {
    const blocks = parseMarkdown(
      [
        '## Today',
        'Eight of **13** people are in.',
        '',
        '- Late: Layla',
        '- On leave: Priya',
        '',
        '1. First',
        '2. Second',
        '',
        '| Name | Status |',
        '|---|---|',
        '| Ahmed Nabil | present |',
        '| Layla Mansour | late |',
        '',
        'Second paragraph',
        'on two lines.',
      ].join('\n'),
    )
    expect(blocks).toEqual([
      { type: 'heading', level: 2, text: 'Today' },
      { type: 'paragraph', text: 'Eight of **13** people are in.' },
      { type: 'list', ordered: false, items: ['Late: Layla', 'On leave: Priya'] },
      { type: 'list', ordered: true, items: ['First', 'Second'] },
      { type: 'table', header: ['Name', 'Status'], rows: [['Ahmed Nabil', 'present'], ['Layla Mansour', 'late']] },
      { type: 'paragraph', text: 'Second paragraph\non two lines.' },
    ])
  })

  it('reads Arabic the same way, and leaves a lone pipe in a sentence alone', () => {
    expect(parseMarkdown('- **متأخرين:** ليلى\n- **في إجازة:** محدش')).toEqual([
      { type: 'list', ordered: false, items: ['**متأخرين:** ليلى', '**في إجازة:** محدش'] },
    ])
    expect(parseMarkdown('Shift A | Shift B')).toEqual([{ type: 'paragraph', text: 'Shift A | Shift B' }])
  })

  it('splits bold, italic and code without ever producing markup', () => {
    expect(parseInline('**3** late, *2* absent, `LV-2026-0003` <b>x</b>')).toEqual([
      { text: '3', bold: true },
      { text: ' late, ' },
      { text: '2', italic: true },
      { text: ' absent, ' },
      { text: 'LV-2026-0003', code: true },
      { text: ' <b>x</b>' },
    ])
  })
})

describe('assistant conversation', () => {
  it('suggests questions for the scope, some in Arabic', () => {
    expect(assistantSuggestions('team').join(' ')).toMatch(/فريقي/)
    expect(assistantSuggestions('company').some((text) => /[؀-ۿ]/.test(text))).toBe(true)
  })

  it('keeps the conversation per person for the tab, and forgets every one on sign-out', () => {
    const storage = memoryStorage()
    saveConversation('u1', [{ role: 'user', text: 'Who is late?' }, { role: 'assistant', text: 'Nobody.', sources: ['Attendance today'] }], storage)
    saveConversation('u2', [{ role: 'user', text: 'Hi' }], storage)
    storage.setItem('pollux.theme', 'dark')

    expect(loadConversation('u1', storage)).toHaveLength(2)
    expect(loadConversation('u3', storage)).toEqual([])

    forgetConversations(storage)
    expect(loadConversation('u1', storage)).toEqual([])
    expect(loadConversation('u2', storage)).toEqual([])
    expect(storage.getItem('pollux.theme')).toBe('dark')
  })

  it('survives broken or missing storage', () => {
    const storage = memoryStorage()
    storage.setItem('pollux.assistant.u1', '{not json')
    expect(loadConversation('u1', storage)).toEqual([])
    expect(loadConversation('u1', undefined)).toEqual([])
    expect(() => saveConversation('u1', [{ role: 'user', text: 'x' }], undefined)).not.toThrow()
  })
})
