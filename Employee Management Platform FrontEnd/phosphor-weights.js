/**
 * Phosphor draws every icon in six weights and ships all six in each icon's
 * module. The app uses three (regular, fill, bold), so this build step drops
 * the others from Phosphor's weight tables - about 60 kB gzipped. Asking for a
 * dropped weight renders nothing, so add it to KEEP before using it.
 */
const KEEP = new Set(['regular', 'fill', 'bold'])
const DEFS = /[\\/]@phosphor-icons[\\/]react[\\/]dist[\\/]defs[\\/][^\\/]+\.es\.js$/

/** The index just past the bracket that closes the one at `start`, skipping strings. */
function closingBracket(code, start) {
  let depth = 0
  for (let index = start; index < code.length; index += 1) {
    const char = code[index]
    if (char === '"' || char === "'" || char === '`') {
      index += 1
      while (index < code.length && code[index] !== char) index += code[index] === '\\' ? 2 : 1
    } else if (char === '[' || char === '(' || char === '{') depth += 1
    else if (char === ']' || char === ')' || char === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

export function stripWeights(code) {
  let out = code
  for (const match of [...code.matchAll(/\[\s*"(thin|light|duotone|regular|fill|bold)",/g)].reverse()) {
    if (KEEP.has(match[1])) continue
    const end = closingBracket(out, match.index)
    if (end < 0) return code
    const comma = /^\s*,/.exec(out.slice(end))
    out = out.slice(0, match.index) + out.slice(end + (comma ? comma[0].length : 0))
  }
  return out
}

export default function phosphorWeights() {
  return {
    name: 'phosphor-weights',
    apply: 'build',
    transform(code, id) {
      if (!DEFS.test(id)) return null
      return { code: stripWeights(code), map: null }
    },
  }
}
