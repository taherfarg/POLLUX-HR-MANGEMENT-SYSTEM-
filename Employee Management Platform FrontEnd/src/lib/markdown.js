/**
 * The small part of Markdown the assistant writes - headings, paragraphs,
 * bullet and numbered lists, tables, bold, italic and code - parsed into plain
 * blocks for React to render. No HTML is ever produced from the text, so a
 * name or note in an answer cannot inject markup.
 */

const TABLE_DIVIDER = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/
const BULLET = /^\s*[-*•]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const HEADING = /^(#{1,4})\s+(.*)$/

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())

/** Splits text into blocks: { type: 'heading'|'paragraph'|'list'|'table', ... }. */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let paragraph = []

  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      flush()
      continue
    }

    const heading = trimmed.match(HEADING)
    if (heading) {
      flush()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }

    // A table: a header row, a divider row, then body rows.
    if (trimmed.includes('|') && TABLE_DIVIDER.test((lines[index + 1] ?? '').trim())) {
      flush()
      const header = cells(trimmed)
      const rows = []
      index += 2
      while (index < lines.length && lines[index].trim().includes('|')) {
        rows.push(cells(lines[index]))
        index += 1
      }
      index -= 1
      blocks.push({ type: 'table', header, rows })
      continue
    }

    const bullet = line.match(BULLET)
    const numbered = !bullet && line.match(NUMBERED)
    if (bullet || numbered) {
      flush()
      const ordered = Boolean(numbered)
      const items = [(bullet || numbered)[1]]
      while (index + 1 < lines.length) {
        const next = lines[index + 1].match(ordered ? NUMBERED : BULLET)
        if (!next) break
        items.push(next[1])
        index += 1
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    paragraph.push(trimmed)
  }
  flush()
  return blocks
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g

/** Splits a line into { text, bold?, italic?, code? } runs. */
export function parseInline(text) {
  const runs = []
  let last = 0
  for (const match of String(text).matchAll(INLINE)) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index) })
    const token = match[0]
    if (token.startsWith('**') || token.startsWith('__')) runs.push({ text: token.slice(2, -2), bold: true })
    else if (token.startsWith('`')) runs.push({ text: token.slice(1, -1), code: true })
    else runs.push({ text: token.slice(1, -1), italic: true })
    last = match.index + token.length
  }
  if (last < text.length) runs.push({ text: text.slice(last) })
  return runs
}
